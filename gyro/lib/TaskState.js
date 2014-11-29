/**
 * @enum {number}
 */
var TaskState = {
  INITIALIZING: 1,
  PENDING: 2,
  IN_PROGRESS: 3,
  IN_PROGRESS_MUST_RERUN: 4,
  FAILED: 5,
  SUCCEEDED: 6
};
module.exports = TaskState;
