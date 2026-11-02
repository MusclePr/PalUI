export type Player = {
  name: string;
  accountName: string;
  playerId: string;
  userId: string;
  ip: string;
  ping: number;
  buildingCount: number;
  level: number;
  lastLogin: string | null;
  banned: boolean;
};

export type RegisteredPlayer = {
  userId: string;
  displayName: string;
  role: string;
  white: boolean;
  banned: boolean;
  level: number;
  lastLogin: string | null;
  firstLogin: string | null;
};

export type PlayerRow = Player & {
  gameName: string;
  rowKey: string;
  role: string;
  online: boolean;
  whitelisted: boolean;
};

export function playerRowKey(player: Pick<Player, "playerId" | "userId">) {
  return JSON.stringify(player.userId ? ["user", player.userId] : ["player", player.playerId]);
}

export function reconcilePlayerItems<T extends object>(current: T[], next: T[], key: (item: T) => string): T[] {
  const byKey = new Map(current.map((item) => [key(item), item]));
  const reconciled = next.map((item) => {
    const previous = byKey.get(key(item));
    return previous && Object.keys(item).length === Object.keys(previous).length
      && (Object.keys(item) as (keyof T)[]).every((field) => item[field] === previous[field]) ? previous : item;
  });
  return current.length === reconciled.length && current.every((item, index) => item === reconciled[index]) ? current : reconciled;
}

export function buildPlayerRows(players: Player[], registeredPlayers: RegisteredPlayer[], whitelist: string[], search: string): PlayerRow[] {
  const onlineByKey = new Map(players.map((player) => [playerRowKey(player), player]));
  const registeredByUserId = new Map(registeredPlayers.map((player) => [player.userId, player]));
  const rowKeys = new Set([
    ...onlineByKey.keys(),
    ...registeredPlayers.map((player) => JSON.stringify(["user", player.userId])),
    ...whitelist.map((userId) => JSON.stringify(["user", userId])),
  ]);

  return [...rowKeys].map((rowKey) => {
    const onlinePlayer = onlineByKey.get(rowKey);
    const userId = onlinePlayer?.userId ?? registeredPlayers.find((player) => JSON.stringify(["user", player.userId]) === rowKey)?.userId ??
      whitelist.find((candidate) => JSON.stringify(["user", candidate]) === rowKey) ?? "";
    const registeredPlayer = registeredByUserId.get(userId);
    const gameName = onlinePlayer?.name?.trim() || "";
    const registeredName = registeredPlayer?.displayName?.trim() || "";
    const name = (registeredName !== userId ? registeredName : "") || gameName || registeredName || userId || onlinePlayer?.playerId || "Unknown player";
    return {
      ...(onlinePlayer ?? {
        name,
        accountName: "",
        playerId: "",
        userId,
        ip: "",
        ping: 0,
        buildingCount: 0,
        level: 0,
        lastLogin: null,
        banned: false,
      }),
      rowKey,
      name,
      gameName,
      level: onlinePlayer?.level || registeredPlayer?.level || 0,
      lastLogin: onlinePlayer?.lastLogin ?? registeredPlayer?.lastLogin ?? null,
      banned: registeredPlayer?.banned === true,
      role: registeredPlayer?.role ?? "--",
      online: onlinePlayer !== undefined,
      whitelisted: whitelist.includes(userId),
    };
  }).filter((player) => `${player.name} ${player.gameName} ${player.accountName} ${player.playerId} ${player.userId}`.toLowerCase().includes(search.toLowerCase()));
}