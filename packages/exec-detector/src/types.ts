// --- OSC 133 Shell Integration Types ---

export enum ShellIntegrationType {
	PromptStart = "A",
	CommandStart = "B",
	CommandExecuted = "C",
	CommandFinished = "D",
}

export interface IShellIntegrationEvent {
	type: ShellIntegrationType;
	params: string[];
}

// --- OSC 133 Discriminated Union (future-ready) ---

export type Osc133Event =
	| { type: "PromptStart" }
	| { type: "CommandStart" }
	| { type: "CommandExecuted" }
	| {
			type: "CommandFinished";
			exitCode?: number;
			params: Record<string, string>;
	  };

// --- OSC 633 (VS Code Shell Integration) ---

export type Osc633Event =
	| { type: "PromptStart" }
	| { type: "CommandStart" }
	| { type: "CommandExecuted" }
	| { type: "CommandFinished"; exitCode?: number }
	| { type: "CommandLine"; command: string; nonce?: string }
	| { type: "ContinuationStart" }
	| { type: "ContinuationEnd" }
	| { type: "RightPromptStart" }
	| { type: "RightPromptEnd" }
	| { type: "Property"; key: string; value: string };

// --- OSC 7 (CWD Notification) ---

export interface Osc7Event {
	scheme: string;
	hostname: string;
	path: string;
}

// --- OSC 9 (Desktop Notification / ConEmu Progress) ---

export type Osc9Event =
	| { type: "notification"; text: string }
	| { type: "progress"; state: number; percentage?: number };

// --- OSC 777 (RXVT Notification) ---

export interface Osc777Event {
	title: string;
	body: string;
}

// --- OSC 0 / OSC 2 (Window Title) ---

export interface OscTitleEvent {
	title: string;
}

// --- OSC 8 (Hyperlink) ---

export type Osc8Event =
	| {
			type: "start";
			uri: string;
			id?: string;
			params: Record<string, string>;
	  }
	| { type: "end" };

// --- OSC 52 (Clipboard) ---

export type Osc52Event =
	| { type: "set"; selection: string; data: string }
	| { type: "query"; selection: string }
	| { type: "clear"; selection: string };
