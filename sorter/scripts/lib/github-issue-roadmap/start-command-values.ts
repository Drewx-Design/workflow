export const START_COMMAND_FIELD_VALUES = ["ce-brainstorm", "ce-plan", "ce-debug", "ce-work", "ce-resolve-pr-feedback", "none"] as const;
export const AUTHORED_START_COMMANDS = ["ce-brainstorm", "ce-plan", "ce-debug", "ce-work"] as const;
export type StartCommandFieldValue = typeof START_COMMAND_FIELD_VALUES[number];
export type AuthoredStartCommand = typeof AUTHORED_START_COMMANDS[number];
