import type { AlgorithmDecision, BucketState } from '../../algorithms/types';
import type { CompiledPolicy } from '../policies/compiled-policy';

/** The outcome of checking ONE policy for a request, before anything is consumed. */
export interface PendingCheck {
  compiled: CompiledPolicy;
  key: string;
  state: BucketState;
  /** State was freshly created for this request and is not in the store yet. */
  isNew: boolean;
  /** State was read from the store (false for new keys and store-full rejections). */
  stored: boolean;
  decision: AlgorithmDecision;
  /** Units reserved for higher priorities (see policies/priority.ts). */
  reserve: number;
}
