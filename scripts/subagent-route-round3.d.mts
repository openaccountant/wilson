/* eslint-disable @typescript-eslint/no-explicit-any */
export function buildBlind(arms: Record<string, any[]>, rand?: () => number): { blind: any[]; key: Record<string, any> };
export function blindLines(blind: any[]): string;
export function armBars(records: any[]): any;
