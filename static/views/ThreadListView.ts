import {Action, Actions, registerActions, Shortcut} from '../Actions.js';
import {assert, defined, notNull} from '../Base.js';
import {login} from '../BaseMain.js';
import {NO_ROOM_NEEDED} from '../calendar/CalendarEvent.js';
import {INSERT_LINK_HIDDEN} from '../EmailCompose.js';
import {SkimModel} from '../models/SkimModel.js';
import {ThreadListChangedEvent, ThreadListModel, UndoEvent} from '../models/ThreadListModel.js';
import {QuickReply, ReplyCloseEvent, ReplyScrollEvent} from '../QuickReply.js';
import {SendAs} from '../SendAs.js';
import {ServerStorage} from '../ServerStorage.js';
import {Settings} from '../Settings.js';
import {BLOCKED_LABEL_NAME} from '../Thread.js';
import {Thread} from '../Thread.js';
import {ARCHIVE_ACTION, BACKLOG_ACTION, BLOCKED_BUTTONS, MUST_DO_ACTION, MUTE_ACTION, NEEDS_FILTER_ACTION, PIN_ACTION, REPEAT_ACTION, SKIM_ACTION, URGENT_ACTION} from '../ThreadActions.js';
import {Timer} from '../Timer.js';
import {Toast} from '../Toast.js';
import {ViewInGmailButton} from '../ViewInGmailButton.js';

import {AppShell} from './AppShell.js';
import {FocusRowEvent, RenderThreadEvent, SelectRowEvent, ThreadRow} from './ThreadRow.js';
import {ThreadRowGroup} from './ThreadRowGroup.js';
import {View} from './View.js';

let rowAtOffset = (rows: ThreadRow[], anchorRow: ThreadRow, offset: number): (
    ThreadRow|null) => {
  if (offset != -1 && offset != 1)
    throw `getRowFromRelativeOffset called with offset of ${offset}`;

  let index = rows.indexOf(anchorRow);
  if (index == -1)
    throw `Tried to get row via relative offset on a row that's not in the dom.`;
  if (0 <= index + offset && index + offset < rows.length)
    return rows[index + offset];
  return null;
};

interface ListenerData {
  name: string, handler: (e: Event) => void,
}

let QUICK_REPLY_ACTION = {
  name: `Reply`,
  description: `Give a short reply.`,
  key: 'r',
};

export let BLOCKED_ACTION = {
  name: BLOCKED_LABEL_NAME,
  description: `Show the blocked buttons.`,
};

export let NEXT_ACTION = {
  name: `Next`,
  description: `Go to the next row/thread/message.`,
  key: 'j',
  secondaryKey: 'ArrowDown',
  hidden: true,
  repeatable: true,
};

export let PREVIOUS_ACTION = {
  name: `Previous`,
  description: `Go to the previous row/thread/message.`,
  key: 'k',
  secondaryKey: 'ArrowUp',
  hidden: true,
  repeatable: true,
};

export let NEXT_FULL_ACTION = {
  name: `Next group or last message`,
  description:
      `Focus the first email of the next group or scroll thread to the last message.`,
  key: 'n',
  secondaryKey: new Shortcut('ArrowDown', false, true),
  hidden: true,
  repeatable: true,
};

export let PREVIOUS_FULL_ACTION = {
  name: `Previous group or first message`,
  description:
      `Focus the first email of the previous group or scroll thread to the first message..`,
  key: 'p',
  secondaryKey: new Shortcut('ArrowUp', false, true),
  hidden: true,
  repeatable: true,
};

let TOGGLE_GROUP_ACTION = {
  name: `Toggle group`,
  description: `Toggle all items in the current group.`,
  key: 'g',
  hidden: true,
};

let TOGGLE_FOCUSED_ACTION = {
  name: `Toggle focused`,
  description: `Toggle whether or not the focused element is selected.`,
  key: ' ',
  hidden: true,
  repeatable: true,
};

let VIEW_FOCUSED_ACTION = {
  name: `View focused`,
  description: `View the focused email.`,
  key: 'Enter',
  hidden: true,
};

let VIEW_THREADLIST_ACTION = {
  name: `View thread list`,
  description: `Go back to the thread list.`,
  key: 'Escape',
  hidden: true,
};

let UNDO_ACTION = {
  name: `Undo`,
  description: `Undoes the last action taken.`,
};

let MOVE_UP_ACTION = {
  name: '⬆',
  description: `Moves the row up in sort order in the Todo view.`,
  key: '[',
  secondaryKey: new Shortcut('ArrowUp', true, false),
  repeatable: true,
};

let MOVE_DOWN_ACTION = {
  name: '⬇',
  description: `Moves the row down in sort order in the Todo view.`,
  key: ']',
  secondaryKey: new Shortcut('ArrowDown', true, false),
  repeatable: true,
};

let BASE_ACTIONS = [
  ARCHIVE_ACTION,
  BLOCKED_ACTION,
  ...BLOCKED_BUTTONS,
  MUTE_ACTION,
  MUST_DO_ACTION,
  URGENT_ACTION,
  BACKLOG_ACTION,
  NEEDS_FILTER_ACTION,
  UNDO_ACTION,
  PREVIOUS_ACTION,
  PREVIOUS_FULL_ACTION,
  NEXT_ACTION,
  NEXT_FULL_ACTION,
  INSERT_LINK_HIDDEN,
];

let SORT_ACTIONS = [
  MOVE_UP_ACTION,
  MOVE_DOWN_ACTION,
];

let RENDER_ALL_ACTIONS = [
  PIN_ACTION,
  TOGGLE_FOCUSED_ACTION,
  TOGGLE_GROUP_ACTION,
  VIEW_FOCUSED_ACTION,
];

let RENDER_ONE_ACTIONS = [
  QUICK_REPLY_ACTION,
  VIEW_THREADLIST_ACTION,
];

registerActions('Triage or Todo', [
  ...BASE_ACTIONS,
  ...SORT_ACTIONS,
  REPEAT_ACTION,
  ...RENDER_ALL_ACTIONS,
  ...RENDER_ONE_ACTIONS,
]);

export class ThreadListView extends View {
  private timerDuration_: number;
  private modelListeners_: ListenerData[];
  private threadToRow_: WeakMap<Thread, ThreadRow>;
  private focusedRow_: ThreadRow|null;
  private noMeetingRoomEvents_: HTMLElement;
  private rowGroupContainer_: HTMLElement;
  private singleThreadContainer_: HTMLElement;
  private renderedRow_: ThreadRow|null;
  private autoFocusedRow_: ThreadRow|null;
  private lastCheckedRow_: ThreadRow|null;
  private renderedGroupName_: string|null;
  private scrollOffset_: number|undefined;
  private hasQueuedFrame_: boolean;
  private hasNewRenderedRow_: boolean;
  private blockedToolbar_?: Actions;
  private labelSelectTemplate_?: HTMLSelectElement;

  constructor(
      private model_: ThreadListModel, private appShell_: AppShell,
      private settings_: Settings, bottomButtonUrl?: string,
      bottomButtonText?: string, private includeSortActions_?: boolean,
      private includeSkimAction_?: boolean,
      private includeRepeatAction_?: boolean) {
    super();

    this.style.cssText = `
      display: flex;
      flex-direction: column;
    `;

    this.timerDuration_ = settings_.get(ServerStorage.KEYS.TIMER_DURATION);

    this.modelListeners_ = [];
    this.threadToRow_ = new WeakMap();
    this.focusedRow_ = null;
    this.renderedRow_ = null;
    this.autoFocusedRow_ = null;
    this.lastCheckedRow_ = null;
    this.renderedGroupName_ = null;
    this.hasQueuedFrame_ = false;
    this.hasNewRenderedRow_ = false;

    this.noMeetingRoomEvents_ = document.createElement('div');
    this.noMeetingRoomEvents_.style.cssText = `
      column-count: 3;
      white-space: nowrap;
    `;
    this.append(this.noMeetingRoomEvents_);

    this.rowGroupContainer_ = document.createElement('div');
    this.rowGroupContainer_.style.cssText = `
      display: flex;
      flex-direction: column;
    `;
    this.append(this.rowGroupContainer_);

    this.rowGroupContainer_.addEventListener(
        RenderThreadEvent.NAME, (e: Event) => {
          this.setRenderedRowIfAllowed_(e.target as ThreadRow);
        });
    this.rowGroupContainer_.addEventListener(FocusRowEvent.NAME, (e: Event) => {
      this.handleFocusRow_(<ThreadRow>e.target);
    });
    this.rowGroupContainer_.addEventListener(
        SelectRowEvent.NAME, (e: Event) => {
          this.handleCheckRow_(
              <ThreadRow>e.target, (e as SelectRowEvent).shiftKey);
        });

    this.singleThreadContainer_ = document.createElement('div');
    this.singleThreadContainer_.style.cssText = `
      position: relative;
    `;
    this.append(this.singleThreadContainer_);

    if (bottomButtonUrl)
      this.appendButton_(defined(bottomButtonText), bottomButtonUrl);

    if (this.includeSkimAction_) {
      // TODO: Use a toggle switch.
      let button = this.appendButton_('Triage remaining');
      button.title = 'View/respond to remaining threads like regular triage.';
      button.addEventListener('click', () => {
        (this.model_ as SkimModel).toggleAllowViewMessages();
        button.textContent = this.model_.allowViewMessages() ?
            'Back to skimming' :
            'Triage remaining';
      });
    }

    this.updateActions_();

    this.addListenerToModel(
        ThreadListChangedEvent.NAME, this.render_.bind(this));
    this.addListenerToModel('undo', (e: Event) => {
      let undoEvent = <UndoEvent>e;
      this.handleUndo_(undoEvent.thread, undoEvent.groupName);
    });

    this.renderCalendar_();
    this.render_();
  }

  private async renderCalendar_() {
    let events = await this.model_.getNoMeetingRoomEvents();
    if (!events.length)
      return;

    this.noMeetingRoomEvents_.before(
        `Meetings without a local room. Ignore by adding "${
            NO_ROOM_NEEDED}" to the location.`);

    for (let event of events) {
      let item = document.createElement('div');
      item.style.cssText = `
        overflow: hidden;
        text-overflow: ellipsis;
      `;

      let link = document.createElement('a');
      link.href = event.editUrl;
      link.append(event.summary);

      item.append(
          `${event.start.getMonth() + 1}/${event.start.getDate()} `, link);
      this.noMeetingRoomEvents_.append(item);
    }
  }

  appendButton_(text: string, url?: string) {
    let button = document.createElement('a');
    button.className = 'label-button';
    if (url)
      button.href = url;
    button.textContent = text;
    this.append(button);
    return button;
  }

  private getThreadRow_(thread: Thread) {
    let row = this.threadToRow_.get(thread);
    if (!row) {
      row = new ThreadRow(thread, defined(this.labelSelectTemplate_));
      this.threadToRow_.set(thread, row);
    }
    return row;
  };

  addListenerToModel(eventName: string, handler: (e: Event) => void) {
    this.modelListeners_.push({
      name: eventName,
      handler: handler,
    });
    this.model_.addEventListener(eventName, handler);
  }

  private handleUndo_(thread: Thread, groupName: string) {
    let row = this.getThreadRow_(thread);
    if (this.renderedRow_)
      this.setRenderedRow_(row, groupName);
    else
      this.setFocus_(row);
  }

  tearDown() {
    for (let listener of this.modelListeners_) {
      this.model_.removeEventListener(listener.name, listener.handler);
    }
    this.appShell_.setSubject('');
    this.appShell_.showBackArrow(false);
  }

  async init() {
    await login();
    await this.model_.loadFromDisk();
    await this.model_.update();
  }

  async goBack() {
    this.transitionToThreadList_(this.renderedRow_);
  }

  updateActions_() {
    let viewSpecific =
        this.renderedRow_ ? RENDER_ONE_ACTIONS : RENDER_ALL_ACTIONS;
    let includeSortActions = this.includeSortActions_ && !this.renderedRow_;
    let sortActions = includeSortActions ? SORT_ACTIONS : [];
    let skimButton = this.includeSkimAction_ ? [SKIM_ACTION] : [];
    let repeat = this.includeRepeatAction_ ? [REPEAT_ACTION] : [];

    this.setActions([
      ...skimButton, ...BASE_ACTIONS, ...viewSpecific, ...sortActions, ...repeat
    ]);

    if (this.renderedRow_)
      this.addTimer_();
  }

  addTimer_() {
    let timer = new Timer(
        !!this.model_.timerCountsDown, this.timerDuration_,
        this.singleThreadContainer_);
    AppShell.addToFooter(timer);
    timer.style.top = `-${timer.offsetHeight}px`;
  }

  private async render_() {
    if (this.hasQueuedFrame_)
      return;
    this.hasQueuedFrame_ = true;

    if (!this.labelSelectTemplate_)
      this.labelSelectTemplate_ = await this.settings_.getLabelSelectTemplate();

    requestAnimationFrame(this.renderFrame_.bind(this));
  }

  getRows_() {
    return <ThreadRow[]>Array.from(
        this.rowGroupContainer_.querySelectorAll('mt-thread-row'));
  }

  getFirstRow_() {
    return <ThreadRow>this.rowGroupContainer_.querySelector('mt-thread-row');
  }

  private renderFrame_() {
    this.hasQueuedFrame_ = false;
    let threads = this.model_.getThreads();
    let oldRows = this.getRows_();

    // This happens when an undo has happened, but the model hasn't yet seen the
    // update from the undo.
    if (this.renderedRow_ && !oldRows.includes(this.renderedRow_) &&
        !threads.includes(this.renderedRow_.thread))
      return;

    this.rowGroupContainer_.textContent = '';
    let currentGroup = null;
    // Threads should be in sorted order already and all threads in the
    // same queue should be adjacent to each other.
    for (let thread of threads) {
      let groupName = this.model_.getGroupName(thread);
      if (!currentGroup || currentGroup.name != groupName) {
        let allowedCount = this.model_.allowedCount(groupName);
        currentGroup = new ThreadRowGroup(groupName, this.model_, allowedCount);
        this.rowGroupContainer_.append(currentGroup);
      }
      currentGroup.push(this.getThreadRow_(thread));
    }

    let newRows = this.getRows_();
    let removedRows = oldRows.filter(x => !newRows.includes(x));
    this.handleRowsRemoved_(removedRows, oldRows);

    if (!this.renderedRow_ && (!this.focusedRow_ || this.autoFocusedRow_)) {
      this.autoFocusedRow_ = newRows[0];
      this.setFocus_(this.autoFocusedRow_);
    }

    // Do this async so it doesn't block putting up the frame.
    setTimeout(() => this.prerender_());
  }

  private handleRowsRemoved_(removedRows: ThreadRow[], oldRows: ThreadRow[]) {
    let toast: HTMLElement|undefined;
    let focused = this.renderedRow_ || this.focusedRow_;
    if (focused && removedRows.find(x => x == focused)) {
      // Find the next row in oldRows that isn't also removed.
      let nextRow = null;
      let index = oldRows.findIndex(x => x == focused);
      for (var i = index + 1; i < oldRows.length; i++) {
        let row = oldRows[i];
        if (!removedRows.find(x => x == row)) {
          nextRow = row;
          break;
        }
      }

      if (this.renderedRow_) {
        if (nextRow) {
          let nextGroupName = this.model_.getGroupName(nextRow.thread);
          if (this.renderedGroupName_ !== nextGroupName) {
            // If the next group is collapsed, go back to the thread list.
            if (this.model_.isCollapsed(nextGroupName))
              nextRow = null;
            else
              toast = new Toast(`Now in: ${nextGroupName}`);
          }
        }
        if (nextRow) {
          this.setRenderedRowInternal_(nextRow);
        } else {
          this.transitionToThreadList_(null);
        }
      } else {
        // Intentionally call even if nextRow is null to clear out the focused
        // row if there's nothing left to focus.
        this.setFocus_(nextRow);
      }
    }

    if (this.hasNewRenderedRow_) {
      this.hasNewRenderedRow_ = false;
      this.renderOne_(toast);
    }
  }

  private prerender_() {
    let row;
    if (this.renderedRow_) {
      row = rowAtOffset(this.getRows_(), this.renderedRow_, 1);
      assert(row !== this.renderedRow_);
    } else {
      row = this.focusedRow_;
    }

    if (!row)
      return;

    let rendered = row.rendered;
    rendered.render();
    rendered.style.bottom = '0';
    rendered.style.visibility = 'hidden';
    this.singleThreadContainer_.append(rendered);
  }

  private setFocus_(row: ThreadRow|null) {
    if (row) {
      let areAnyRowsChecked = this.getRows_().some(x => x.checked);
      let focusImpliesSelected = !areAnyRowsChecked;
      row.setFocus(true, focusImpliesSelected);
      // If the row isn't actually in the tree, then it's focus event won't
      // bubble up to the ThreadListView, so manually set this.focusedRow_.
      if (!row.parentNode)
        this.setFocusInternal_(row);
    } else {
      this.clearFocus_();
    }
  }

  clearFocus_() {
    this.autoFocusedRow_ = null;
    this.setFocusInternal_(null);
  }

  private setFocusInternal_(row: ThreadRow|null) {
    if (this.focusedRow_)
      this.focusedRow_.clearFocus();
    this.focusedRow_ = row;
  }

  private preventAutoFocusFirstRow_() {
    this.autoFocusedRow_ = null;
  }

  private handleFocusRow_(row: ThreadRow) {
    // Once a row gets manually focused, stop auto-focusing.
    if (row !== this.autoFocusedRow_)
      this.preventAutoFocusFirstRow_();

    if (row !== this.focusedRow_)
      this.setFocusInternal_(row);
  }

  private handleCheckRow_(row: ThreadRow, rangeSelect: boolean) {
    // Double check that the last selected row is still actually selected.
    if (rangeSelect && this.lastCheckedRow_ && this.lastCheckedRow_.checked) {
      let rows = this.getRows_();
      let lastIndex = rows.indexOf(this.lastCheckedRow_);
      let newIndex = rows.indexOf(row);
      let start = (lastIndex < newIndex) ? lastIndex : newIndex;
      let end = (lastIndex < newIndex) ? newIndex : lastIndex;
      for (var i = start; i < end; i++) {
        rows[i].checked = true;
      }
    }
    this.lastCheckedRow_ = row;
  }

  private setFocusAndScrollIntoView_(row: ThreadRow|null) {
    this.setFocus_(row);
    if (this.focusedRow_)
      this.focusedRow_.scrollIntoView({'block': 'center'});
  }

  private moveRow_(action: Action) {
    let selectedRows = this.getRows_().filter(x => x.selected);
    if (!selectedRows.length)
      return;

    // If the first row is auto selected because it's the first row, make sure
    // it stays focused after it's moved.
    this.preventAutoFocusFirstRow_();

    let firstSelected = selectedRows[0];
    let group = firstSelected.getGroup();
    let rows = group.getRows();

    let beforeFirstSelected = [];
    let selected = [];
    let afterFirstSelected = [];
    for (let row of rows) {
      if (row.selected)
        selected.push(row);
      else if (selected.length)
        afterFirstSelected.push(row);
      else
        beforeFirstSelected.push(row);
    }

    if (action === MOVE_UP_ACTION) {
      let itemToMove = beforeFirstSelected.pop();
      if (itemToMove)
        afterFirstSelected.splice(0, 0, itemToMove);
    } else {
      let itemToMove = afterFirstSelected.shift();
      if (itemToMove)
        beforeFirstSelected.push(itemToMove);
    }

    let sorted = [...beforeFirstSelected, ...selected, ...afterFirstSelected];
    this.model_.setSortOrder(sorted.map(x => x.thread));
  }

  private moveFocus_(action: Action) {
    let rows = this.getRows_();
    if (!rows.length)
      return;

    let focused = assert(this.focusedRow_);

    switch (action) {
      case NEXT_ACTION: {
        const nextRow = rowAtOffset(rows, focused, 1);
        if (nextRow)
          this.setFocusAndScrollIntoView_(nextRow);
        break;
      }
      case PREVIOUS_ACTION: {
        const previousRow = rowAtOffset(rows, focused, -1);
        if (previousRow)
          this.setFocusAndScrollIntoView_(previousRow);
        break;
      }
      case NEXT_FULL_ACTION: {
        let currentGroup = focused.getGroup();
        let newGroup = currentGroup.nextElementSibling as ThreadRowGroup;
        while (newGroup && newGroup.isCollapsed()) {
          newGroup = newGroup.nextElementSibling as ThreadRowGroup;
        }
        this.focusFirstRowOfGroup_(newGroup);
        break;
      }
      case PREVIOUS_FULL_ACTION: {
        let currentGroup = focused.getGroup();
        let newGroup = currentGroup.previousElementSibling as ThreadRowGroup;
        while (newGroup && newGroup.isCollapsed()) {
          newGroup = newGroup.previousElementSibling as ThreadRowGroup;
        }
        this.focusFirstRowOfGroup_(newGroup);
        break;
      }
    }
  }

  focusFirstRowOfGroup_(group: ThreadRowGroup) {
    if (!group)
      return;
    let firstRow = <ThreadRow>group.querySelector('mt-thread-row');
    this.setFocusAndScrollIntoView_(firstRow);
  }

  private toggleBlockedToolbar_() {
    if (this.blockedToolbar_) {
      this.blockedToolbar_.remove();
      this.blockedToolbar_ = undefined;
    } else {
      this.blockedToolbar_ = new Actions(this, true);
      this.blockedToolbar_.setActions(BLOCKED_BUTTONS);
      AppShell.addToFooter(this.blockedToolbar_);
    }
  }

  async takeAction(action: Action) {
    switch (action) {
      case BLOCKED_ACTION:
        this.toggleBlockedToolbar_();
        return;

      case UNDO_ACTION:
        this.model_.undoLastAction();
        return;

      case QUICK_REPLY_ACTION:
        await this.showQuickReply();
        return;

      case MOVE_DOWN_ACTION:
      case MOVE_UP_ACTION:
        this.moveRow_(action);
        return;

      case NEXT_FULL_ACTION:
      case PREVIOUS_FULL_ACTION:
      case NEXT_ACTION:
      case PREVIOUS_ACTION:
        if (this.renderedRow_)
          this.renderedRow_.rendered.moveFocus(action);
        else
          this.moveFocus_(action);
        return;

      case TOGGLE_FOCUSED_ACTION:
        this.toggleFocused_();
        return;

      case TOGGLE_GROUP_ACTION:
        this.toggleQueue_();
        return;

      case VIEW_THREADLIST_ACTION:
        this.transitionToThreadList_(this.renderedRow_);
        return;

      case VIEW_FOCUSED_ACTION:
        this.viewFocused_();
        return;

      default:
        await this.markTriaged_(action);
    }
  }

  toggleFocused_() {
    let focused = notNull(this.focusedRow_);
    focused.checked = !focused.checked;
    this.moveFocus_(NEXT_ACTION);
  }

  private toggleQueue_() {
    let focused = notNull(this.focusedRow_);
    const checking = !focused.checked;
    let rows = focused.getGroup().getRows();
    for (let row of rows) {
      row.checked = checking;
    }
  }

  private setRenderedRowIfAllowed_(row: ThreadRow) {
    if (!this.model_.allowViewMessages())
      return;
    this.setRenderedRow_(row);
  }

  private viewFocused_() {
    if (!this.focusedRow_)
      this.moveFocus_(NEXT_ACTION);
    if (!this.focusedRow_)
      return;
    this.setRenderedRowIfAllowed_(this.focusedRow_);
  }

  private transitionToThreadList_(focusedRow: ThreadRow|null) {
    this.appShell_.showBackArrow(false);

    this.rowGroupContainer_.style.display = 'flex';
    this.singleThreadContainer_.textContent = '';
    this.appShell_.contentScrollTop = this.scrollOffset_ || 0;

    this.setFocusAndScrollIntoView_(focusedRow);
    this.setRenderedRow_(null);
    this.appShell_.setSubject('');
    this.updateActions_();

    this.render_();
  }

  transitionToSingleThread_() {
    this.appShell_.showBackArrow(true);

    this.scrollOffset_ = this.appShell_.contentScrollTop;
    this.rowGroupContainer_.style.display = 'none';
  }

  private async markTriaged_(destination: Action) {
    // REPEAT_ACTION doesn't cause the row to move around, so don't remove the
    // row.
    let keepRows = destination === REPEAT_ACTION;

    if (this.renderedRow_) {
      // Save off the row since handleRowsRemoved_ sets this.renderedRow_ in
      // some cases.
      let row = this.renderedRow_;
      if (!keepRows)
        this.handleRowsRemoved_([row], this.getRows_());
      await this.model_.markSingleThreadTriaged(row.thread, destination);
    } else {
      let threads: Thread[] = [];
      let firstUnselectedRowAfterFocused = null;
      let focusedRowIsSelected = false;

      let rows = this.getRows_();
      for (let child of rows) {
        if (child.selected) {
          if (child == this.focusedRow_)
            focusedRowIsSelected = true;
          threads.push(child.thread);

          if (keepRows)
            continue;

          // ThreadRows get recycled, so clear the checked and focused state
          // for future use.
          child.resetState();

          // TODO: Instead of removing rows outside of model changes, which
          // causes races, move focus state into the model so that it all
          // updates atomically.
          let parentGroup = child.getGroup();
          // The rows will get removed on the next frame anyways, but we don't
          // want the user to see an intermediary state where the row is shown
          // but unchecked and we don't want to move focus to the next row
          // until these rows have been removed. So just removed them
          // synchronously here purely for the visual effect. This also has
          // the important side effect of not blocking the UI changes on
          // network activity.
          child.remove();
          // Remove the parent group if it's now empty so the user doens't see
          // a flicker where the row is removed without it's parent group also
          // being removed.
          parentGroup.removeIfEmpty();
        } else if (focusedRowIsSelected && !firstUnselectedRowAfterFocused) {
          firstUnselectedRowAfterFocused = child;
        }
      }

      if (!threads.length)
        return;

      // Move focus to the first unselected email. If we aren't able to find
      // an unselected email, focusedEmail_ should end up null, so set it even
      // if firstUnselectedRowAfterSelected is null.
      if (!keepRows && focusedRowIsSelected)
        this.setFocus_(firstUnselectedRowAfterFocused);

      await this.model_.markThreadsTriaged(threads, destination);
    }
  }

  setRenderedRowInternal_(row: ThreadRow|null, groupName?: string) {
    this.hasNewRenderedRow_ = !!row;
    if (this.renderedRow_)
      this.renderedRow_.rendered.remove();
    this.renderedRow_ = row;
    // This is read in renderFrame_. At that point, the rendered row will have
    // already been triaged and will no longer have a group name.
    this.renderedGroupName_ =
        groupName || (row ? this.model_.getGroupName(row.thread) : null);
  }

  setRenderedRow_(row: ThreadRow|null, groupName?: string) {
    this.setRenderedRowInternal_(row, groupName);
    if (row)
      this.render_();
  }

  renderOne_(toast?: HTMLElement) {
    if (this.rowGroupContainer_.style.display != 'none')
      this.transitionToSingleThread_();

    let renderedRow = notNull(this.renderedRow_);
    let rendered = renderedRow.rendered;
    assert(
        !rendered.isRendered() ||
            rendered.parentNode == this.singleThreadContainer_,
        'Tried to rerender already rendered thread. This should never happen.');

    if (!rendered.isRendered()) {
      rendered.render();
      this.singleThreadContainer_.append(rendered);
    }

    rendered.style.bottom = '';
    rendered.style.visibility = 'visible';

    this.updateActions_();
    if (toast)
      AppShell.addToFooter(toast);

    // If you click on a row before it's pulled in message details, handle it
    // semi-gracefully.
    // TODO: Once the message details load, call the code below to add the
    // subject, etc.
    let messages = renderedRow.thread.getMessages();
    if (!messages.length) {
      this.appShell_.setSubject('');
      return;
    }

    let viewInGmailButton = new ViewInGmailButton();
    viewInGmailButton.setMessageId(messages[messages.length - 1].id);
    viewInGmailButton.style.display = 'inline-flex';

    let subject = document.createElement('div');
    subject.style.flex = '1';
    subject.append(renderedRow.thread.getSubject());
    this.appShell_.setSubject(subject, viewInGmailButton);

    rendered.focusFirstUnread();
    // Check if new messages have come in since we last fetched from the
    // network. Intentionally don't await this since we don't want to
    // make renderOne_ async.
    renderedRow.thread.update();
  }

  async showQuickReply() {
    let reply = new QuickReply(
        notNull(this.renderedRow_).thread, await SendAs.getDefault());
    reply.addEventListener(ReplyCloseEvent.NAME, () => this.updateActions_());

    reply.addEventListener(ReplyScrollEvent.NAME, async () => {
      if (!this.renderedRow_)
        return;

      let row = this.renderedRow_;
      if (row.thread === reply.thread) {
        row.rendered.showSpinner(true);
        await row.thread.update();
        row.rendered.showSpinner(false);
        row.rendered.moveFocus(NEXT_FULL_ACTION, {behavior: 'smooth'});
      }
    });

    this.setActions([]);
    AppShell.setFooter(reply);
    this.addTimer_();

    reply.focus();
  }
}
window.customElements.define('mt-thread-list-view', ThreadListView);
