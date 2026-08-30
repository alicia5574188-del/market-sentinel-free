export function hte31TimeoutExitReason(input: {
  maxHoldingMinutes: number;
  target1Hit: boolean;
  maximumFavorableR: number;
}) {
  return input.target1Hit || input.maximumFavorableR >= 0.9
    ? `已兑现至少第一目标但未完成TP2，超过 ${input.maxHoldingMinutes} 分钟后锁定结果`
    : `超过 ${input.maxHoldingMinutes} 分钟仍未兑现第一目标，执行时间止损`;
}

export function isSustainedHte31StopRecovery(input: {
  exitCode: string | null;
  favorableR: number;
  currentRecoveryR: number;
  adverseR: number;
}) {
  return input.exitCode === "stop_loss"
    && input.favorableR >= 1
    && input.currentRecoveryR >= 0.5
    && input.adverseR < 1;
}
