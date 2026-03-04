import { describe, test, expect, mock, beforeEach } from 'bun:test';

// Mock long-term chat history before importing controller
let mockMessages: string[] = [];
let mockAddedMessages: string[] = [];
let mockUpdatedResponses: string[] = [];

mock.module('../utils/long-term-chat-history.js', () => ({
  LongTermChatHistory: class {
    async load() {}
    getMessageStrings() {
      return [...mockMessages];
    }
    async addUserMessage(msg: string) {
      mockAddedMessages.push(msg);
      mockMessages.unshift(msg);
    }
    async updateAgentResponse(response: string) {
      mockUpdatedResponses.push(response);
    }
  },
}));

import { InputHistoryController } from '../controllers/input-history.js';

describe('InputHistoryController', () => {
  beforeEach(() => {
    mockMessages = [];
    mockAddedMessages = [];
    mockUpdatedResponses = [];
  });

  test('constructor creates controller', () => {
    const ctrl = new InputHistoryController();
    expect(ctrl).toBeDefined();
  });

  test('constructor accepts onChange listener', async () => {
    let called = false;
    const ctrl = new InputHistoryController(() => { called = true; });
    // init triggers emitChange
    await ctrl.init();
    expect(called).toBe(true);
  });

  test('init loads history and emits change', async () => {
    mockMessages = ['old query'];
    let changed = false;
    const ctrl = new InputHistoryController(() => { changed = true; });
    await ctrl.init();
    expect(changed).toBe(true);
    expect(ctrl.getMessages()).toEqual(['old query']);
  });

  test('historyValue is null at index -1', async () => {
    const ctrl = new InputHistoryController();
    await ctrl.init();
    expect(ctrl.historyValue).toBeNull();
  });

  test('navigateUp moves to first message', async () => {
    mockMessages = ['msg1', 'msg2'];
    const ctrl = new InputHistoryController();
    await ctrl.init();

    ctrl.navigateUp();
    expect(ctrl.historyValue).toBe('msg1');
  });

  test('navigateUp twice moves to second message', async () => {
    mockMessages = ['msg1', 'msg2'];
    const ctrl = new InputHistoryController();
    await ctrl.init();

    ctrl.navigateUp();
    ctrl.navigateUp();
    expect(ctrl.historyValue).toBe('msg2');
  });

  test('navigateUp does not go past end', async () => {
    mockMessages = ['only'];
    const ctrl = new InputHistoryController();
    await ctrl.init();

    ctrl.navigateUp();
    ctrl.navigateUp(); // Should stay at index 0
    expect(ctrl.historyValue).toBe('only');
  });

  test('navigateUp does nothing when history is empty', async () => {
    const ctrl = new InputHistoryController();
    await ctrl.init();

    ctrl.navigateUp();
    expect(ctrl.historyValue).toBeNull();
  });

  test('navigateDown returns to null from index 0', async () => {
    mockMessages = ['msg1', 'msg2'];
    const ctrl = new InputHistoryController();
    await ctrl.init();

    ctrl.navigateUp(); // index 0
    ctrl.navigateDown(); // back to -1
    expect(ctrl.historyValue).toBeNull();
  });

  test('navigateDown moves towards recent', async () => {
    mockMessages = ['msg1', 'msg2', 'msg3'];
    const ctrl = new InputHistoryController();
    await ctrl.init();

    ctrl.navigateUp(); // 0
    ctrl.navigateUp(); // 1
    ctrl.navigateUp(); // 2
    ctrl.navigateDown(); // 1
    expect(ctrl.historyValue).toBe('msg2');
  });

  test('navigateDown does nothing when already at -1', async () => {
    const ctrl = new InputHistoryController();
    await ctrl.init();
    ctrl.navigateDown(); // Should be a no-op
    expect(ctrl.historyValue).toBeNull();
  });

  test('resetNavigation sets index back to -1', async () => {
    mockMessages = ['msg1'];
    const ctrl = new InputHistoryController();
    await ctrl.init();

    ctrl.navigateUp();
    expect(ctrl.historyValue).toBe('msg1');
    ctrl.resetNavigation();
    expect(ctrl.historyValue).toBeNull();
  });

  test('getMessages returns copy of messages', async () => {
    mockMessages = ['a', 'b'];
    const ctrl = new InputHistoryController();
    await ctrl.init();

    const result = ctrl.getMessages();
    expect(result).toEqual(['a', 'b']);
  });

  test('saveMessage adds to store and updates local messages', async () => {
    const ctrl = new InputHistoryController();
    await ctrl.init();

    await ctrl.saveMessage('new input');
    expect(mockAddedMessages).toEqual(['new input']);
    // After save, messages should be refreshed from store
    expect(ctrl.getMessages()).toContain('new input');
  });

  test('updateAgentResponse delegates to store', async () => {
    const ctrl = new InputHistoryController();
    await ctrl.init();

    await ctrl.updateAgentResponse('agent says hi');
    expect(mockUpdatedResponses).toEqual(['agent says hi']);
  });

  test('setOnChange replaces listener', async () => {
    let count1 = 0;
    let count2 = 0;
    const ctrl = new InputHistoryController(() => { count1++; });
    await ctrl.init();
    const calls1 = count1;

    ctrl.setOnChange(() => { count2++; });
    ctrl.resetNavigation(); // triggers emitChange
    expect(count1).toBe(calls1); // old listener not called again
    expect(count2).toBe(1);
  });
});
