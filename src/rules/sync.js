// 同步的判定逻辑（纯函数，方便测）：
// 写入用的是「请求开始那一刻」的数据快照。如果请求期间本地又改过，
// 就不能把状态标成「已同步」，也不能用远端返回的内容覆盖当前数据 ——
// 否则用户在这几秒里的修改会被悄悄吞掉。

export function writeOutcome({ snapshotRev, currentRev } = {}) {
  const changedDuringWrite = (snapshotRev || 0) !== (currentRev || 0);
  return {
    changedDuringWrite,
    clearPending: !changedDuringWrite,
    pushAgain: changedDuringWrite
  };
}
