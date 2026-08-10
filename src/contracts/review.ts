import type { WorkflowStage } from "./stages.js";

export const REVIEW_DECISIONS = ["approve", "revise", "regenerate", "abort"] as const;

export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

export interface RevisionTarget {
  stage: WorkflowStage;
  revision: number;
}

export interface ReviewInput {
  target: RevisionTarget;
  decision: ReviewDecision;
  feedback?: string;
  targetIds?: readonly string[];
}

export function isReviewDecision(value: string): value is ReviewDecision {
  return (REVIEW_DECISIONS as readonly string[]).includes(value);
}
