import { Container, Spacer, Text, type TUI } from '@mariozechner/pi-tui';
import type { TokenUsage } from '../agent/types.js';
import { theme } from '../theme.js';
import { AnswerBoxComponent } from './answer-box.js';
import { ToolEventComponent } from './tool-event.js';
import { UserQueryComponent } from './user-query.js';

function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) {
    return `${seconds}s`;
  }
  return `${minutes}m ${seconds}s`;
}

interface ToolDisplayComponent {
  setActive(progressMessage?: string): void;
  setComplete(summary: string, duration: number): void;
  setError(error: string): void;
  setLimitWarning(warning?: string): void;
  setApproval(decision: 'allow-once' | 'allow-session' | 'deny'): void;
  setDenied(path: string, tool: string): void;
}

export class ChatLogComponent extends Container {
  private readonly tui: TUI;
  private readonly toolById = new Map<string, ToolDisplayComponent>();
  private activeAnswer: AnswerBoxComponent | null = null;
  private lastToolName: string | null = null;
  private lastToolComponent: ToolDisplayComponent | null = null;

  constructor(tui: TUI) {
    super();
    this.tui = tui;
  }

  clearAll() {
    this.clear();
    this.toolById.clear();
    this.activeAnswer = null;
    this.lastToolName = null;
    this.lastToolComponent = null;
  }

  addQuery(query: string) {
    this.addChild(new UserQueryComponent(query));
  }

  resetToolGrouping() {
    this.lastToolName = null;
    this.lastToolComponent = null;
  }

  addInterrupted() {
    this.addChild(new Text(`${theme.muted('⎿  Interrupted · What should Wilson do instead?')}`, 0, 0));
  }

  startTool(toolCallId: string, toolName: string, args: Record<string, unknown>) {
    const existing = this.toolById.get(toolCallId);
    if (existing) {
      existing.setActive();
      return existing;
    }

    if (this.lastToolName === toolName && this.lastToolComponent) {
      this.lastToolComponent.setActive();
      this.toolById.set(toolCallId, this.lastToolComponent);
      return this.lastToolComponent;
    }

    const component = new ToolEventComponent(this.tui, toolName, args);
    component.setActive();
    this.toolById.set(toolCallId, component);
    this.addChild(component);
    this.lastToolName = toolName;
    this.lastToolComponent = component;
    return component;
  }

  updateToolProgress(toolCallId: string, message: string) {
    const existing = this.toolById.get(toolCallId);
    if (!existing) {
      return;
    }
    existing.setActive(message);
  }

  completeTool(toolCallId: string, summary: string, duration: number) {
    const existing = this.toolById.get(toolCallId);
    if (!existing) {
      return;
    }
    existing.setComplete(summary, duration);
  }

  errorTool(toolCallId: string, error: string) {
    const existing = this.toolById.get(toolCallId);
    if (!existing) {
      return;
    }
    existing.setError(error);
  }

  limitTool(toolCallId: string, warning?: string) {
    const existing = this.toolById.get(toolCallId);
    if (!existing) {
      return;
    }
    existing.setLimitWarning(warning);
  }

  approveTool(toolCallId: string, decision: 'allow-once' | 'allow-session' | 'deny') {
    const existing = this.toolById.get(toolCallId);
    if (!existing) {
      return;
    }
    existing.setApproval(decision);
  }

  denyTool(toolCallId: string, path: string, tool: string) {
    const existing = this.toolById.get(toolCallId);
    if (!existing) {
      return;
    }
    existing.setDenied(path, tool);
  }

  finalizeAnswer(text: string) {
    if (!this.activeAnswer) {
      this.addChild(new AnswerBoxComponent(text));
      return;
    }
    this.activeAnswer.setText(text);
    this.activeAnswer = null;
  }

  addContextCleared(clearedCount: number, keptCount: number) {
    this.addChild(
      new Text(
        `${theme.muted(
          `⏺ Context threshold reached - cleared ${clearedCount} old tool result${clearedCount !== 1 ? 's' : ''}, kept ${keptCount} most recent`,
        )}`,
        0,
        0,
      ),
    );
  }

  addPerformanceStats(duration: number, tokenUsage?: TokenUsage, tokensPerSecond?: number) {
    if (!tokenUsage) {
      return;
    }
    const parts = [formatDuration(duration), `${tokenUsage.totalTokens.toLocaleString()} tokens`];
    if (tokensPerSecond !== undefined) {
      parts.push(`(${tokensPerSecond.toFixed(1)} tok/s)`);
    }
    this.addChild(new Spacer(1));
    this.addChild(new Text(`${theme.muted('✻ ')}${theme.muted(parts.join(' · '))}`, 0, 0));
  }
}
