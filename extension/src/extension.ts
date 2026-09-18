import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { DistractionDiaryProvider, DistractionRecord, DistractionType } from './DistractionDiaryProvider';

/**
 * ---------------------------------------------------------------------------
 * Distraction Diary — main extension entry point
 * ---------------------------------------------------------------------------
 *
 * Responsibilities of this module:
 *
 *  1. DISTRACTION TRIGGERS
 *       a. Window focus loss   -> `vscode.window.onDidChangeWindowState`
 *       b. Idle timer          -> an activity-tracking timer that is reset
 *                                 on every editor interaction.
 *
 *  2. MEMORY
 *       Session history lives in the `DistractionDiaryProvider` (in-memory,
 *       bounded by `distractionDiary.maxRecords`).
 *
 *  3. WELCOME-BACK POP-UP
 *       When the window regains focus — or the user types again after an
 *       idle distraction — an information message offers a one-click
 *       "Go to Line N" action.
 *
 *  4. TELEPORTER
 *       `distractionDiary.jumpToRecord` opens the recorded file and places
 *       the cursor exactly where the user left it.
 *
 *  5. LIFECYCLE
 *       `activate` wires up the view, the command, and every listener;
 *       `deactivate` stops the idle timer. All disposables are tracked in
 *       the extension context so nothing leaks when the extension host
 *       unloads us.
 * ---------------------------------------------------------------------------
 */

/** View id — must match `contributes.views` in package.json. */
const DIARY_VIEW_ID = 'distractionDiary';

/** Command id — must match `contributes.commands` in package.json. */
const JUMP_COMMAND_ID = 'distractionDiary.jumpToRecord';

/** Namespace under which the extension's settings live. */
const CONFIG_SECTION = 'distractionDiary';

/** Default idle threshold in minutes (used if the setting is missing). */
const DEFAULT_IDLE_TIMEOUT_MINUTES = 3;

/**
 * Module-level state for the distraction/return state machine.
 *
 * Kept as plain module scope (rather than a class) because there is exactly
 * one active instance of an extension per extension host; the three values
 * form a tiny, tightly-coupled state machine:
 *
 *   `distractionActive`  -> were we marked as distracted?
 *   `lastDistraction`    -> and where were we, if so?
 *   `idleTimer`          -> the pending idle-detection timeout, if any.
 */
let distractionActive = false;
let lastDistraction: DistractionRecord | null = null;
let idleTimer: NodeJS.Timeout | undefined;

/** The provider owns the session history; the extension core talks to it. */
let diaryProvider: DistractionDiaryProvider;

// ---------------------------------------------------------------------------
// Extension lifecycle
// ---------------------------------------------------------------------------

/**
 * Called by VS Code when the extension activates. Sets up the tree view,
 * the jump command, and every distraction trigger.
 *
 * @param context The extension context — used to register disposables.
 */
export function activate(context: vscode.ExtensionContext): void {
	// 1. Create the provider (it owns the in-memory session history).
	diaryProvider = new DistractionDiaryProvider();

	// 2. Register the "Distraction Diary" tree view inside our container.
	const treeView = vscode.window.createTreeView(DIARY_VIEW_ID, {
		treeDataProvider: diaryProvider,
		canSelectMany: false,
		showCollapseAll: false
	});
	context.subscriptions.push(treeView);

	// 3. Register the Teleporter command. The tree view rows call it with a
	//    record as their argument (see DistractionDiaryProvider.createTreeItem).
	context.subscriptions.push(
		vscode.commands.registerCommand(JUMP_COMMAND_ID, (record?: DistractionRecord) => {
			if (record) {
				void jumpToRecord(record);
			}
		})
	);

	// 4. Window focus-loss / focus-regained trigger.
	context.subscriptions.push(
		vscode.window.onDidChangeWindowState((state: vscode.WindowState) => {
			if (state.focused) {
				// The user came back to the window.
				onWindowRefocused();
			} else if (
				vscode.workspace
					.getConfiguration(CONFIG_SECTION)
					.get<boolean>('recordFocusLoss', true)
			) {
				// The user left the window — record where they were.
				recordDistraction('focus-loss');
			}
		})
	);

	// 5. Editor activity listeners — every one of these resets the idle timer.
	//    a. Selection / cursor movement in a text editor (covers typing,
	//       arrow keys, and mouse clicks in the editor).
	context.subscriptions.push(
		vscode.window.onDidChangeTextEditorSelection(() => onEditorActivity())
	);

	//    b. A different editor becomes active (tab switching, opening a new
	//       file from the explorer, ...).
	context.subscriptions.push(
		vscode.window.onDidChangeActiveTextEditor(() => onEditorActivity())
	);

	//    c. Any document edit — catches typing even in editors whose selection
	//       change event doesn't fire (e.g. some webview-backed editors).
	context.subscriptions.push(
		vscode.workspace.onDidChangeTextDocument(() => onEditorActivity())
	);

	// 6. React to setting changes: the idle threshold can be changed at any
	//    time without reloading the window.
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((event: vscode.ConfigurationChangeEvent) => {
			if (event.affectsConfiguration(`${CONFIG_SECTION}.idleTimeoutMinutes`)) {
				// Re-arm the timer with the freshly-read threshold.
				startIdleTimer();
			}
		})
	);

	// 7. Start the idle timer for the first time.
	startIdleTimer();
}

/**
 * Called by VS Code when the extension is deactivated (window close, reload,
 * or extension disable). Clears the pending idle timer so it cannot fire
 * after we've unloaded.
 */
export function deactivate(): void {
	clearIdleTimer();
}

// ---------------------------------------------------------------------------
// Distraction triggers
// ---------------------------------------------------------------------------

/**
 * Records that the user has been distracted.
 *
 * Edge cases handled here:
 *  - If we are *already* marked as distracted we do not record again
 *    (otherwise one long distraction would flood the diary with duplicate
 *    rows for the same moment).
 *  - If there is no active text editor (e.g. the user was in the terminal,
 *    or the last editor tab was closed) we simply do not record anything —
 *    there is no "last known location" in a text file to remember.
 *  - If the active editor's file no longer exists on disk (edge case: the
 *    file was deleted while the user was distracted), we still record the
 *    in-memory location so the diary is honest about what was happening;
 *    the Teleporter will surface a friendly warning later.
 *
 * @param type Which trigger fired this record.
 */
function recordDistraction(type: DistractionType): void {
	if (distractionActive) {
		return; // Already distracted — keep the first (oldest) record.
	}

	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		return; // No text editor is focused — nothing to remember.
	}

	// Grab the cursor position defensively: selections can be absent in
	// rare transient states, so fall back to line 1.
	const selection = editor.selection;
	const line = selection ? selection.active.line + 1 : 1; // 1-based.
	const character = selection ? selection.active.character + 1 : 1; // 1-based.

	const record: DistractionRecord = {
		filePath: editor.document.fileName,
		line,
		character,
		timestamp: Date.now(),
		type
	};

	lastDistraction = record;
	distractionActive = true;

	// Push the record into the diary tree (the provider handles the cap and
	// fires the refresh event).
	diaryProvider.addRecord(record);

	// Arm the idle timer so that if the user *never* comes back, we at least
	// get one clean idle record per absence rather than a cascade of them.
	startIdleTimer();
}

/**
 * Handler for "the user came back to the window" (focus regained).
 *
 * If we were marked as distracted, show the welcome-back pop-up with a
 * one-click jump button, then reset the state machine.
 */
function onWindowRefocused(): void {
	if (!distractionActive || !lastDistraction) {
		// We were never distracted (e.g. the user just toggled between two
		// of their own VS Code windows) — nothing to announce.
		return;
	}

	showWelcomeBackMessage(lastDistraction);
	resetDistractionState();
}

/**
 * Resets the distraction state machine after the user has returned.
 */
function resetDistractionState(): void {
	distractionActive = false;
	lastDistraction = null;
}

// ---------------------------------------------------------------------------
// Idle timer
// ---------------------------------------------------------------------------

/**
 * Reads the current idle threshold from settings, in milliseconds.
 * A value of 0 (or a non-finite value) disables idle tracking.
 */
function getIdleTimeoutMs(): number {
	const minutes = vscode.workspace
		.getConfiguration(CONFIG_SECTION)
		.get<number>('idleTimeoutMinutes', DEFAULT_IDLE_TIMEOUT_MINUTES);
	if (!Number.isFinite(minutes) || minutes <= 0) {
		return 0; // Idle tracking disabled.
	}
	return minutes * 60 * 1000;
}

/**
 * (Re-)schedules the idle distraction.
 *
 * Clears any pending timer, then reads the current idle threshold in
 * milliseconds from the user's settings. If the threshold is non-zero a
 * `recordDistraction('idle')` call is scheduled after that many
 * milliseconds; a threshold of 0 disables idle tracking entirely.
 */
function startIdleTimer(): void {
	clearIdleTimer();
	const timeoutMs = getIdleTimeoutMs();
	if (timeoutMs <= 0) {
		return; // Idle tracking is disabled.
	}
	idleTimer = setTimeout(() => {
		recordDistraction('idle');
	}, timeoutMs);
}

/** Clears the pending idle timer, if any. */
function clearIdleTimer(): void {
	if (idleTimer) {
		clearTimeout(idleTimer);
		idleTimer = undefined;
	}
}

/**
 * Called on any editor interaction (typing, cursor movement, tab switch,
 * document edit).
 *
 * - If we were marked as distracted *by the idle timer*, the user has
 *   returned: show the welcome-back pop-up and reset the state machine.
 * - In all cases the idle timer is re-armed from zero.
 */
function onEditorActivity(): void {
	if (distractionActive && lastDistraction && lastDistraction.type === 'idle') {
		// The user resumed typing after an idle distraction.
		showWelcomeBackMessage(lastDistraction);
		resetDistractionState();
	}
	startIdleTimer();
}

// ---------------------------------------------------------------------------
// Welcome-back pop-up
// ---------------------------------------------------------------------------

/**
 * Shows the "Welcome back!" information message in the bottom-right corner
 * with a single action button that jumps the user to their recorded spot.
 *
 * The message follows the required copy exactly:
 *   "Welcome back! You were working on [Filename] at line [Line Number]."
 *
 * @param record The distraction record the user was last at.
 */
function showWelcomeBackMessage(record: DistractionRecord): void {
	const fileName = path.basename(record.filePath);
	const message = `Welcome back! You were working on ${fileName} at line ${record.line}.`;
	const actionLabel = `Go to Line ${record.line}`;

	void vscode.window
		.showInformationMessage(message, { modal: false }, actionLabel)
		.then((choice) => {
			if (choice === actionLabel) {
				void jumpToRecord(record);
			}
		});
}

// ---------------------------------------------------------------------------
// The Teleporter
// ---------------------------------------------------------------------------

/**
 * Opens the file a record points at and places the cursor exactly on the
 * recorded line (and column, since we captured it).
 *
 * Edge cases handled:
 *  - The file no longer exists on disk (deleted while the user was away):
 *    we surface a warning and skip the jump rather than crashing.
 *  - The file is an untitled/unsaved buffer: `document.open` cannot re-open
 *    it by URI, so we check whether an editor for that URI is already open
 *    and, if not, fall back to a warning.
 *  - The recorded line is beyond the current end of the file (the file was
 *    truncated while the user was away): we clamp to the last line.
 *
 * @param record The distraction record to teleport to.
 */
async function jumpToRecord(record: DistractionRecord): Promise<void> {
	// Edge case: the file has been deleted or moved while the user was away.
	if (record.filePath && fs.existsSync(record.filePath)) {
		const uri = vscode.Uri.file(record.filePath);

// Open the file in an existing or new editor. `preserveFocus: false`
		// so the editor takes focus (we want to *be* on that line, not just
		// peek at it).
		const editor = await vscode.window.showTextDocument(uri, {
			preserveFocus: false
		});

		// Clamp the line number into the document's actual range in case the
		// file got shorter than the recorded line.
		const totalLines = editor.document.lineCount;
		const targetLine = Math.min(record.line - 1, totalLines - 1); // 0-based.
		const targetChar = Math.min(record.character - 1, Math.max(0, editor.document.lineAt(targetLine).text.length));

		// Place the selection (and therefore the caret) exactly on the spot.
		editor.selection = new vscode.Selection(targetLine, targetChar, targetLine, targetChar);
		editor.revealRange(
			new vscode.Range(targetLine, targetChar, targetLine, targetChar),
			vscode.TextEditorRevealType.InCenterIfOutsideViewport
		);

		// Jump complete: the file is open and the caret is parked.
		return;
	}

	// The file is gone (or was never a real file on disk).
	void vscode.window.showWarningMessage(
		`Distraction Diary: the file "${path.basename(record.filePath)}" is no longer available, so I can't take you back there.`
	);
}