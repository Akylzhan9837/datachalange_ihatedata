export interface TranscriptItem {
  timestamp: string;
  speaker: 'client' | 'operator' | 'bot' | 'system' | string;
  text: string;
}

export interface Conversation {
  conversation_id: string;
  channel: string;
  language: string;
  transcript: TranscriptItem[];
  audio_url: string | null;
}

export interface DatasetResponse {
  error: string;
  isSuccess: boolean;
  data: {
    dataset_group_id: string;
    total_records: number;
    records: Conversation[];
  };
}

export interface ChecklistCriterion {
  id: string;
  section: string;
  title: string;
  description: string;
  type: 'binary' | 'scale';
  weight: number;
  na_allowed: boolean;
  is_gross?: boolean;
  steps?: number[];
  max_step?: number;
}

export interface Checklist {
  id: string;
  version: number;
  title: string;
  sections: string[];
  criteria: ChecklistCriterion[];
}

export interface EvaluationCriterionResult {
  criterion_id: string;
  answer: 'yes' | 'no' | 'na' | number;
  step?: number | null;
  evidence: number[];
  checked_range?: [number, number];
  reason: string;
  na_reason?: string | null;
  points?: number;
  weight?: number;
  needs_review?: boolean;
  review_reason?: string | null;
}

export interface RuleFlag {
  criterion_id: string;
  rule: string;
  message: string;
  index: number | null;
}

export interface EvaluationResult {
  id: string;
  conversation_id: string;
  checklist_id: string;
  checklist_version: number;
  model: string;
  cost: number;
  evaluated_at: string;
  items: EvaluationCriterionResult[];
  total_score: number | null;
  section_scores: Record<string, number | null>;
  gross_violation: boolean;
  rule_flags?: RuleFlag[];
}

export interface Appeal {
  id: string;
  evaluation_id: string;
  criterion_id: string;
  comment: string;
  status: 'pending' | 'accepted' | 'rejected';
  original_answer: 'yes' | 'no' | 'na' | number;
  original_score: number | null;
  reviewer_answer?: 'yes' | 'no' | 'na' | number;
  reviewer_reason?: string;
  final_score?: number | null;
  created_at: string;
  updated_at?: string;
}
