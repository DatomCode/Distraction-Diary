import * as vscode from 'vscode';

/**
 * The kind of event that caused a distraction to be recorded.
 *
 * - `idle`       : the user stopped interacting with the editor for the
 *                  configured number of minutes.
 * - `focus-loss` : the VS Code window lost OS focus (e.g. the user clicked
 *                  into another application or window).
 */
export type DistractionType = 'idle' | 'focus-loss';

/**
 * A single "memory" entry: where the user was in the code at the moment
 * they were distracted. All values are plain data so the record can be
 * passed as a command argument or serialized if we ever persist it.
 */
export interface DistractionRecord {
	/** Absolute path of the file the user was editing. */
	filePath: string;
	/** 1-based line number of the cursor when the distraction was recorded. */
	line: number;
	/** 1-based character offset of the cursor (lets us restore the exact column). */
	character: number;
	/** Epoch milliseconds of the moment the distraction was recorded. */
	timestamp: number;
	/** Which trigger fired this record. */
	type: DistractionType;
}

/**
 * TreeDataProvider that backs the "Distraction Diary" view in the
 * Activity Bar container. It owns the in-memory session history and
 * notifies the view to refresh whenever a record is added or cleared.
 */
export class DistractionDiaryProvider implements vscode.TreeDataProvider<DistractionRecord> {
	/**
	 * Session history, newest entry first (index 0 is the most recent
	 * distraction). The cap is applied by the extension core, which owns
	 * the `maxRecords` setting, so the provider stays a dumb store.
	 */
	private records: DistractionRecord[] = [];

	/**
	 * Fires whenever the underlying data changes so VS Code re-renders
	 * the tree view. Passing `undefined` refreshes the whole tree, which
	 * is all we ever need here.
	 */
	private readonly onChange = new vscode.EventEmitter<void>();

	/** VS Code subscribes to this to know when to refresh the view. */
	public readonly onDidChangeTreeData: vscode.Event<void> = this.onChange.event;

	/**
	 * Append a new record to the front of the session list and refresh
	 * the view. Called from extension.ts whenever a distraction fires.
	 */
	public addRecord(record: DistractionRecord): void {
		this.records.unshift(record);
		this.onChange.fire();
	}

	/**
	 * Drop every record (e.g. a future "clear diary" command or when the
	 * extension deactivates and re-activates within the same session).
	 */
	public clear(): void {
		this.records = [];
		this.onChange.fire();
	}

	/** Read-only access to the history, newest first. */
	public get all(): ReadonlyArray<DistractionRecord> {
		return this.records;
	}

	/**
	 * Root of the tree: a flat list of every record this session. The
	 * tree view renders this as a plain, non-nested list.
	 */
	public getTreeItem(element: DistractionRecord): vscode.TreeItem {
		return this.createTreeItem(element);
	}

	/** No children — the diary is a flat list, not a hierarchy. */
	public getChildren(_element?: DistractionRecord): DistractionRecord[] {
		return this.records;
	}

	// ------------------------------------------------------------------
	// Tree item rendering
	// ------------------------------------------------------------------

	private createTreeItem(record: DistractionRecord): vscode.TreeItem {
		const fileName = basename(record.filePath);

		// "line N" — the tree item description (small text, right aligned).
		const item = new vscode.TreeItem(fileName);
		item.description = `line ${record.line}`;

		// Full tooltip: time, file, and the kind of distraction, so the
		// user can hover for details that don't fit on one line.
		const when = new Date(record.timestamp).toLocaleString();
		item.tooltip = new vscode.MarkdownString(
			`**${record.type === 'idle' ? 'Idle' : 'Focus loss'}** at ${when}\n\n` +
			`${record.filePath} — line ${record.line}`
		);

		// Little visual hint of which trigger fired the record.
		item.iconPath = record.type === 'idle'
			? new vscode.ThemeIcon('clock')
			: new vscode.ThemeIcon('window');

		// Clicking the row executes the Teleporter command with this
		// record as its argument (registered in extension.ts).
		item.command = {
			command: 'distractionDiary.jumpToRecord',
			title: 'Distraction Diary: Jump to Recorded Location',
			arguments: [record]
		};

		// Stable id keeps focus/scroll position sane across refreshes.
		item.id = `${record.filePath}:${record.timestamp}`;

		return item;
	}
}

/**
 * Tiny helper to grab a file name without pulling in Node's `path`
 * module (works for both Windows and POSIX separators).
 */
function basename(p: string): string {
	const parts = p.split(/[\\/]/);
	return parts[parts.length - 1] || p;
}