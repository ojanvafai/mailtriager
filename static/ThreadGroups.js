export class ThreadGroups {
  constructor() {
    this.triaged_ = [];
    this.needsTriage_ = [];
    this.bestEffort_ = [];
    this.listener_;
  }

  setListener(view) {
    this.listener_ = view;
  }

  processBestEffort() {
    this.setBestEffort(null);
    if (this.listener_.update)
      this.listener_.update();
  }
  pushBestEffort(thread) {
    // After we've started triaging best effort threads, no longer push things
    // to the best effort queue.
    if (!this.bestEffort_) {
      this.pushNeedsTriage(thread);
      return;
    }

    this.bestEffort_.push(thread);
    if (this.listener_ && this.listener_.pushBestEffort)
      this.listener_.pushBestEffort(thread);
  }
  getBestEffort() {
    return this.bestEffort_;
  }
  setBestEffort(array) {
    if (this.bestEffort_)
      this.bestEffort_ = array;
  }
}
