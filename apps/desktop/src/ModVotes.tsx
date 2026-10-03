import { ThumbsDown, ThumbsUp } from 'lucide-react';
import { apiRequest, errorMessage } from './api';
import { trackFeature } from './telemetry';

export type VoteInfo = {
  upvotes: number;
  downvotes: number;
  score: number;
  my_vote: number;
};

export async function castModVote(
  targetType: 'trusted' | 'community',
  targetId: string,
  value: 1 | -1 | 0,
): Promise<VoteInfo> {
  const response = await apiRequest('/v1/mods/vote', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target_type: targetType, target_id: targetId, value }),
  });
  const payload = (await response.json()) as VoteInfo & { ok?: boolean };
  trackFeature('mod_vote', `${targetType}:${value}`);
  return {
    upvotes: Number(payload.upvotes) || 0,
    downvotes: Number(payload.downvotes) || 0,
    score: Number(payload.score) || 0,
    my_vote: Number(payload.my_vote) || 0,
  };
}

export function ModVoteButtons({
  targetType,
  targetId,
  votes,
  demo,
  disabled,
  onChange,
  onError,
}: {
  targetType: 'trusted' | 'community';
  targetId: string;
  votes?: VoteInfo | null;
  demo?: boolean;
  disabled?: boolean;
  onChange: (next: VoteInfo) => void;
  onError?: (message: string) => void;
}) {
  const current = votes ?? { upvotes: 0, downvotes: 0, score: 0, my_vote: 0 };

  async function vote(next: 1 | -1) {
    if (demo || disabled) return;
    const value = current.my_vote === next ? 0 : next;
    try {
      onChange(await castModVote(targetType, targetId, value));
    } catch (reason) {
      onError?.(errorMessage(reason, 'Could not save your vote.'));
    }
  }

  return (
    <div className="mod-vote-row" aria-label="Mod votes">
      <button
        type="button"
        className={current.my_vote === 1 ? 'active up' : ''}
        disabled={!!disabled || !!demo}
        aria-pressed={current.my_vote === 1}
        aria-label="Upvote"
        onClick={() => void vote(1)}
      >
        <ThumbsUp size={13} /> {current.upvotes}
      </button>
      <button
        type="button"
        className={current.my_vote === -1 ? 'active down' : ''}
        disabled={!!disabled || !!demo}
        aria-pressed={current.my_vote === -1}
        aria-label="Downvote"
        onClick={() => void vote(-1)}
      >
        <ThumbsDown size={13} /> {current.downvotes}
      </button>
      <small>Score {current.score}</small>
    </div>
  );
}
