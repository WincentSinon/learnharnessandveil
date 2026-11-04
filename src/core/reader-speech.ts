/** Local Windows read-aloud bridge; PDF text is never sent to a model. */
export interface ReaderSpeechVoice {
	name: string;
	language: string;
}

export interface ReaderSpeechState {
	status: "idle" | "speaking" | "paused" | "error";
	requestId: string | null;
	error?: string;
}

export interface ReaderSpeechInput {
	text: string;
	voice: string;
	/** Windows speech rate, an integer between -10 and 10. */
	rate: number;
	requestId: string;
}

export interface ReaderSpeechBridge {
	voices: () => Promise<ReaderSpeechVoice[]>;
	speak: (input: ReaderSpeechInput) => Promise<ReaderSpeechState>;
	pause: () => Promise<ReaderSpeechState>;
	resume: () => Promise<ReaderSpeechState>;
	stop: () => Promise<ReaderSpeechState>;
	state: () => Promise<ReaderSpeechState>;
	onState: (callback: (state: ReaderSpeechState) => void) => () => void;
	onProgress?: (callback: (progress: ReaderSpeechProgress) => void) => () => void;
}

export interface ReaderSpeechProgress {
	requestId: string;
	start: number;
	end: number;
	unit: "sentence" | "word";
}
