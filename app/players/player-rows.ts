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
  rowKey: string;
  role: string;
  online: boolean;
  whitelisted: boolean;
};

export function playerRowKey(player: Pick<Player, "playerId" | "userId">) {
  return JSON.stringify(player.userId ? ["user", player.userId] : ["player", player.playerId]);
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
    const name = onlinePlayer?.name?.trim() || registeredPlayer?.displayName?.trim() || userId || onlinePlayer?.playerId || "Unknown player";
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
      level: onlinePlayer?.level || registeredPlayer?.level || 0,
      lastLogin: onlinePlayer?.lastLogin ?? registeredPlayer?.lastLogin ?? null,
      banned: onlinePlayer?.banned === true || registeredPlayer?.banned === true,
      role: registeredPlayer?.role ?? "--",
      online: onlinePlayer !== undefined,
      whitelisted: whitelist.includes(userId) || registeredPlayer?.white === true,
    };
  }).filter((player) => `${player.name} ${player.accountName} ${player.playerId} ${player.userId}`.toLowerCase().includes(search.toLowerCase()));
}