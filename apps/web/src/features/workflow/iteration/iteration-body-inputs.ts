// Iteration 输入编辑入口；通用 Graph Input 不依赖此模块。
export {
  ITERATION_ITEMS_KEY,
  createEmptyIterationComposite,
  initializeIterationBody,
} from './inputs/composite';
export {
  setIterationItemType,
  addBodyInput,
  removeBodyInput,
  updateBodyInput,
} from './inputs/body-inputs';
export {
  type BodyInputSourceOption,
  bodyInputSourceOptions,
  setBodyInputMapping,
} from './inputs/body-input-mapping';
export {
  addInvariantInput,
  removeInvariantInput,
  updateInvariantInput,
} from './inputs/invariant-inputs';
