import type {
  ActionableErrorIdentity,
  ActionableErrorKind,
  ActionableErrorState,
} from '../../shared/types';

export const EMPTY_ACTIONABLE_ERROR_STATE: ActionableErrorState = {
  revision: 0,
  notice: null,
};

/** Keep the newest main-owned snapshot across bootstrap/live-push races. */
export function mergeActionableErrorState(
  current: ActionableErrorState,
  incoming: ActionableErrorState,
): ActionableErrorState {
  return incoming.revision >= current.revision ? incoming : current;
}

/** CAS token for the current notice, optionally restricted to repair kinds. */
export function actionableErrorIdentity(
  state: ActionableErrorState,
  kinds?: readonly ActionableErrorKind[],
): ActionableErrorIdentity | null {
  const notice = state.notice;
  if (notice === null || (kinds !== undefined && !kinds.includes(notice.kind))) return null;
  return { revision: state.revision, kind: notice.kind };
}
