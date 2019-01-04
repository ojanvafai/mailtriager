import {Model} from '../models/Model.js';

export abstract class View extends HTMLElement {
  constructor() {
    super();
  }

  abstract getModel(): Model;
  tearDown() {}
  async init() {};
  async goBack() {}
  async update() {}
  async dispatchShortcut(_e: KeyboardEvent) {};
}
