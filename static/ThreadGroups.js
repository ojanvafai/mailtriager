class ThreadGroups {
  constructor() {
    this.triaged_ = [];
    this.needsTriage_ = [];
    this.bestEffort_ = [];
    this.listener_;
  }

  setListener(view) {
    this.listener_ = view;
  }

  pushTriaged(thread) {
    this.triaged_.push(thread);
    if (this.listener_ && this.listener_.pushTriaged)
      this.listener_.pushTriaged(thread);
  }
  getTriaged() {
    return this.triaged_;
  }
  setTriaged(array) {
    this.triaged_ = array;
  }

  pushNeedsTriage(thread) {
    this.needsTriage_.push(thread);
    if (this.listener_ && this.listener_.pushNeedsTriage)
      this.listener_.pushNeedsTriage(thread);
  }
  getNeedsTriage() {
    return this.needsTriage_;
  }
  setNeedsTriage(array) {
    this.needsTriage_ = array;
  }

  pushBestEffort(thread) {
    this.bestEffort_.push(thread);
    if (this.listener_ && this.listener_.pushBestEffort)
      this.listener_.pushBestEffort(thread);
  }
  getBestEffort() {
    return this.bestEffort_;
  }
  setBestEffort(array) {
    this.bestEffort_ = array;
  }
}
