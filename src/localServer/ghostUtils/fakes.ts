import { IPositionTransformer, packetAbilities } from "@icetank/mcproxy";
import { Client, PacketMeta, ServerClient } from "minecraft-protocol";
import { Bot as VanillaBot, GameState } from "mineflayer";
import type { Entity } from "prismarine-entity";
import type { Item as ItemType } from "prismarine-item";
import merge from "ts-deepmerge";
import { Vec3 } from "vec3";

type OmitX<ToRemove extends number, Args extends any[], Remain extends any[] = []> = ToRemove extends Remain["length"]
  ? Args
  : Args extends []
  ? never
  : Args extends [first?: infer Arg, ...i: infer Rest]
  ? OmitX<ToRemove, Rest, [...Remain, Arg]>
  : never;

const itemLoader = require("prismarine-item/index.js"); // ncc compat, get default.
const fetch = require("node-fetch");

function gameModeToNotchian(gamemode: string): 1 | 0 | 2 | 3 {
  switch (gamemode) {
    case "survival":
      return 0;
    case "creative":
      return 1;
    case "adventure":
      return 2;
    case "spectator":
      return 3;
    default:
      return 0;
  }
}

function objectEqual(item1?: object, item2?: object) {
  item1 = item1 ?? {};
  item2 = item2 ?? {};
  return JSON.stringify(item1) === JSON.stringify(item2);
}

const NoneItemData = {
  blockId: -1,
  itemCount: undefined,
  itemDamage: undefined,
  nbtData: undefined,
} as any;

class FakeEntity {
  armor: Array<object | undefined>;
  id: number;
  knownPosition: Vec3;
  yaw: number;
  pitch: number;
  oldYaw: number;
  oldPitch: number;
  onGround: boolean;
  mainHand?: object;
  offHand?: object;
  fixedProperties: any[] = [];

  /**
   * rounded float (yaw) to integer within mc's limits.
   */
  public get intYaw() {
    return -(Math.floor(((this.yaw / Math.PI) * 128 + 255) % 256) - 127);
  }

  /**
   * rounded float (pitch) to integer within mc's limits.
   */
  public get intPitch() {
    return -Math.floor(((this.pitch / Math.PI) * 128) % 256);
  }

  constructor(id: number, pos: Vec3, yaw: number, pitch: number, onGround = true) {
    this.id = id;
    this.knownPosition = pos;
    this.yaw = yaw;
    this.pitch = pitch;
    this.oldYaw = yaw;
    this.oldPitch = pitch;
    this.onGround = onGround;
    this.armor = [];
  }

  static fromEntity(id: number, entity: Entity, PrisItem: typeof ItemType) {
    const tmp = new FakeEntity(id, entity.position, entity.yaw, entity.pitch, entity.onGround);
    tmp.syncToEntity(entity, PrisItem);
    return tmp;
  }

  public syncToEntityPos(entity: Entity) {
    this.knownPosition.set(entity.position.x, entity.position.y, entity.position.z);
    this.oldYaw = this.yaw;
    this.oldPitch = this.pitch;
    this.yaw = entity.yaw;
    this.pitch = entity.pitch;
    this.onGround = entity.onGround;
  }

  public syncToEntity(entity: Entity, PrisItem: typeof ItemType) {
    this.syncToEntityPos(entity);
    this.mainHand = PrisItem.toNotch(entity.heldItem);
    this.offHand = PrisItem.toNotch(entity.equipment[1]); // updated on entities, but maybe not the bot.
    this.armor = entity.equipment.slice(2).map((i) => PrisItem.toNotch(i));
  }

  public getPositionData() {
    return {
      ...this.knownPosition,
      yaw: this.yaw,
      pitch: this.pitch,
      onGround: this.onGround,
    };
  }
}

interface FakeBotEntityOpts {
  username: string;
  uuid: string;
  skinLookup: boolean;
  positionTransformer?: IPositionTransformer;
}

const DefaultPlayerOpts: FakeBotEntityOpts = {
  username: "GhostPlayer",
  uuid: "a01e3843-e521-3998-958a-f459800e4d11",
  skinLookup: true,
};

type AllowedClient = Client;

export class FakeBotEntity {
  public static id = 9999;

  private _synced = false;

  public readonly opts: FakeBotEntityOpts;
  public readonly entityRef: FakeEntity;

  public readonly linkedBot: Bot;
  public readonly linkedClients: Map<string, Client> = new Map();

  protected PrisItem: typeof ItemType;

  public get linkedEntity() {
    return this.linkedBot.entity;
  }

  public get synced() {
    return this._synced;
  }

  public get positionTransformer() {
    return this.opts.positionTransformer;
  }

  constructor(bot: Bot, opts: Partial<FakeBotEntityOpts> = {}) {
    this.opts = merge(DefaultPlayerOpts, opts) as any;
    this.linkedBot = bot;
    this.PrisItem = itemLoader(bot.version);
    this.entityRef = FakeEntity.fromEntity(FakeBotEntity.id, bot.entity, this.PrisItem);
  }

  /// /////////////
  // util funcs //
  /// /////////////

  writeRaw = writeRaw;

  getPositionData = getPositionData;

  protected writeAll(name: string, data: any) {
    for (const c of this.linkedClients.values()) this.writeRaw(c, name, data);
  }

  public doForAllClients = <Func extends (client: Client, ...args: any[]) => any>(func: Func, ...args: OmitX<1, Parameters<Func>>) => {
    for (const c of this.linkedClients.values()) func.call(this, c, ...args);
  };

  public onLinkedMove = (pos: Vec3) => {
    this.entityRef.syncToEntityPos(this.linkedEntity);

    this.writeAll("entity_teleport", {
      entityId: this.entityRef.id,
      ...this.entityRef.knownPosition,
      yaw: this.entityRef.intYaw,
      pitch: this.entityRef.intPitch,
      onGround: this.entityRef.onGround,
    });
    this.writeAll("entity_look", {
      entityId: this.entityRef.id,
      yaw: this.entityRef.intYaw,
      pitch: this.entityRef.intPitch,
      onGround: this.entityRef.onGround,
    });

    this.writeAll("entity_head_rotation", {
      entityId: this.entityRef.id,
      headYaw: this.entityRef.intYaw,
    });
  };

  public onLinkedForceMove = () => {
    this.entityRef.syncToEntityPos(this.linkedEntity);
    this.writeAll("entity_teleport", {
      entityId: this.entityRef.id,
      ...this.entityRef.getPositionData(),
    });
  };

  public onItemChange = () => {
    this.linkedBot.updateHeldItem(); // shouldn't be needed.
    this.doForAllClients(this.updateEquipmentFor);
  };

  public updateEquipmentFor = (client: Client) => {
    const mainHand = this.linkedBot.heldItem != null ? this.PrisItem.toNotch(this.linkedBot.heldItem) : NoneItemData;
    const offHand = this.linkedBot.inventory.slots[45] ? this.PrisItem.toNotch(this.linkedBot.inventory.slots[45]) : NoneItemData;

    const entityEquipWrite = (slot: number, item: ItemType) =>
      this.writeRaw(client, "entity_equipment", { entityId: this.entityRef.id, slot, item });

    if (!objectEqual(mainHand, this.entityRef.mainHand)) {
      entityEquipWrite(0, mainHand);
      this.entityRef.mainHand = mainHand;
    }

    if (!objectEqual(offHand, this.entityRef.offHand)) {
      entityEquipWrite(1, offHand);
      this.entityRef.offHand = offHand;
    }

    const equipmentMap = [5, 4, 3, 2];
    for (let i = 0; i < 4; i++) {
      const armorItem = this.linkedBot.inventory.slots[i + 5] ? this.PrisItem.toNotch(this.linkedBot.inventory.slots[i + 5]) : NoneItemData;

      if (!objectEqual(armorItem, this.entityRef.armor[i])) {
        entityEquipWrite(equipmentMap[i], armorItem);
        this.entityRef.armor[i] = armorItem;
      }
    }
  };

  listenerWorldLeave = () => {
    // listen for 5 seconds, then determine that we are not re-joining.
    const timeout = setTimeout(() => {
      this.linkedBot._client.off("position", this.listenerWorldJoin);
    }, 5000);

    // if new pos happens, clear removal listener and fire event.
    this.linkedBot._client.once("position", () => {
      clearTimeout(timeout);
      this.listenerWorldJoin();
    });
    this.doForAllClients(this.writeDestroyEntity);
  };

  listenerWorldJoin = () => this.doForAllClients(this.writePlayerEntity);

  async getPlayerUuid(): Promise<string | null> {
    let resp;
    try {
      resp = await fetch(`https://api.minecraftservices.com/minecraft/profile/lookup/name/${this.linkedBot.username}`);
      if (resp.status !== 200) {
        console.warn(`Request for ${this.linkedBot.username} failed!`);
        return null;
      }

      const data = await resp.json();
      if (!data.id) {
        console.warn(`uuid for ${this.linkedBot.username} is not present in lookup!`);
        return null;
      }
      return data.id;
    } catch (e) {
      console.error("uuid lookup failed:", e, resp);
      return null;
    }
  }

  async loadPlayerInfo(client: Client) {
    let properties = [];
    if (this.opts.skinLookup) {
      const uuid = await this.getPlayerUuid();
      if (uuid != null) {
        let response;
        try {
          response = await fetch(`https://sessionserver.mojang.com/session/minecraft/profile/${uuid}?unsigned=false`);
          if (response.status === 204) console.warn("Offline mode, no skin for", uuid);
          else {
            const p = await response.json();
            properties = p?.properties ?? [];
            if (properties?.length !== 1) console.warn("Skin lookup failed for", uuid);

            // added for 1.19
            for (const prop of properties) {
              prop["key"] = prop["name"];
              delete prop["name"];
            }
          }
        } catch (err) {
          console.error("Skin lookup failed", err, response);
        }
      }
    }
    this.entityRef.fixedProperties = properties;
    this.writeRaw(client, "player_info", {
      action: 63,
      data: [
        {
          uuid: this.opts.uuid,
          player: {
            name: this.opts.username,
            properties,
          },
          gamemode: gameModeToNotchian(this.linkedBot.game.gameMode),
          latency: 0,
          listed: true,
        },
      ],
    });
  }

  private readonly writePlayerEntity = (client: Client) => {
    this.writeRaw(client, "named_entity_spawn", {
      entityId: this.entityRef.id,
      playerUUID: this.opts.uuid,
      ...this.entityRef.knownPosition,
      yaw: this.entityRef.yaw,
      pitch: this.entityRef.pitch,
    });

    this.writeRaw(client, "entity_look", {
      entityId: this.entityRef.id,
      yaw: this.entityRef.yaw,
      pitch: this.entityRef.pitch,
      onGround: this.entityRef.onGround,
    });

    this.writeRaw(client, "entity_head_rotation", {
      entityId: this.entityRef.id,
      headYaw: this.entityRef.intYaw,
    });

    // this.updateEquipmentFor(client);
  };

  private writeDestroyEntity(client: Client) {
    this.writeRaw(client, "entity_destroy", {
      entityIds: [this.entityRef.id],
    });
  }

  private despawn(client: Client) {
    this.writeDestroyEntity(client);
    this.writeRaw(client, "player_info", {
      action: 4,
      data: [{ uuid: this.opts.uuid }],
    });
  }

  public spawn(client: Client) {
    this.loadPlayerInfo(client)
      .then(() => this.writePlayerEntity(client))
      .catch(console.error);
  }

  public subscribe(client: AllowedClient) {
    if (this.linkedClients.get(client.uuid) != null) return;
    this.linkedClients.set(client.uuid, client);
    this.spawn(client);
  }

  public unsubscribe(client: AllowedClient) {
    if (this.linkedClients.get(client.uuid) == null) return;
    this.despawn(client);
    this.linkedClients.delete(client.uuid);
  }

  public sync() {
    this.entityRef.syncToEntity(this.linkedBot.entity, this.PrisItem);
    this.linkedBot.on("move", this.onLinkedMove);
    this.linkedBot.on("forcedMove", this.onLinkedForceMove);
    this.linkedBot.inventory.on("updateSlot", this.onItemChange);
    this.linkedBot._client.on("mcproxy:heldItemSlotUpdate", this.onItemChange);
    this.linkedBot.on("respawn", this.listenerWorldLeave);
    this._synced = true;
  }

  public unsync() {
    this.linkedBot.off("move", this.onLinkedMove);
    this.linkedBot.off("forcedMove", this.onLinkedForceMove);
    this.linkedBot.inventory.off("updateSlot", this.onItemChange);
    this.linkedBot._client.off("mcproxy:heldItemSlotUpdate", this.onItemChange);
    this.linkedBot.off("respawn", this.listenerWorldLeave);
    this._synced = false;
  }
}

export class GhostInfo {
  public readonly clientRef: Client;
  public readonly pos: Vec3;
  public yaw: number;
  public pitch: number;
  public onGround: boolean;

  public cleanup: () => void;

  constructor(client: Client, cleanup = () => {}) {
    this.clientRef = client;
    this.cleanup = cleanup;
    this.pos = new Vec3(0, 0, 0);
    this.yaw = 0;
    this.pitch = 0;
    this.onGround = false;
  }

  getPositionData = getPositionData;

  posListener = (data: any, meta: PacketMeta) => {
    if (meta.name.includes("position")) {
      this.pos.set(data.x, data.y, data.z);
      this.onGround = data.onGround;
    }
    if (meta.name.includes("look")) {
      this.yaw = data.yaw;
      this.pitch = data.pitch;
      this.onGround = data.onGround;
    }
  };
}

interface GhostHandlerOpts {}

const DefaultGhostHandlerOpts: GhostHandlerOpts = {};

export class GhostHandler {
  public readonly linkedFakeBot: FakeBotEntity;
  public readonly clientsInCamera: Record<string, GhostInfo> = {};

  public opts: GhostHandlerOpts;

  public get linkedBot() {
    return this.linkedFakeBot.linkedBot;
  }

  public get positionTransformer() {
    return this.linkedFakeBot.positionTransformer;
  }

  constructor(host: FakeBotEntity, opts: Partial<GhostHandlerOpts> = {}) {
    this.linkedFakeBot = host;
    this.opts = merge(DefaultGhostHandlerOpts, opts) as any;
  }

  writeRaw = writeRaw;

  private writePlayerInfo(client: Client, action: number, uuid: string, additional: object) {
    this.writeRaw(client, "player_info", {
      action,
      data: [{ uuid, ...additional }],
    });
  }

  public tpToFakePlayer(client: Client) {
    this.writeRaw(client, "position", this.linkedFakeBot.entityRef.getPositionData());
  }

  public tpToOtherClient(client: Client, username: string) {
    let target;
    for (const clientUser in this.clientsInCamera) {
      if (username === clientUser) {
        target = this.clientsInCamera[clientUser];
        break;
      }
    }
    if (target == null) return;
    this.writeRaw(client, "position", target.getPositionData());
  }

  public makeSpectator(client: Client) {
    this.writeRaw(client, "abilities", {
      flags: 7,
      flyingSpeed: 0.05000000074505806,
      walkingSpeed: 0.10000000149011612,
    });

    // TODO: fix
    this.writePlayerInfo(client, 4, client.uuid, { gamemode: 3 });

    https://wiki.vg/index.php?title=Protocol&oldid=14204#Change_Game_State
    this.writeRaw(client, "game_state_change", { reason: 3, gameMode: 3 });

    this.writePlayerInfo(client, 63, this.linkedFakeBot.opts.uuid, {
      player: { name: this.linkedFakeBot.opts.username, properties: this.linkedFakeBot.entityRef.fixedProperties },
    });
    this.linkedFakeBot.subscribe(client);
    this.makeInvisible(client);
  }

  public revertPov(client: Client) {
    if (!this.clientsInCamera[client.uuid]) return false;

    this.unregister(client);

    this.writeRaw(client, "camera", {
      cameraId: this.linkedBot.entity.id,
    });

    return true;
  }

  private addToTab(client: ServerClient | Client, gamemode: number, uuid: string, name: string, properties: any[]) {
    // FakeSpectator.debugLog('Adding to tab', client.username, gamemode, name);
    // TODO: Fix this
  }

  private makeInvisible(client: Client | ServerClient) {
    // FakeSpectator.debugLog('Making invisible', client.username);
    return;
    // @TODO: Fix this
    this.writeRaw(client, "entity_metadata", {
      entityId: this.linkedBot.entity.id,
      metadata: [
        { key: 0, type: 0, value: 32 },
        { key: 10, type: 1, value: 0 },
      ],
    });
  }

  private makeVisible(client: ServerClient | Client) {
    // FakeSpectator.debugLog('Making visible', client.username);
    return;
    // @TODO: Fix this
    this.writeRaw(client, "entity_metadata", {
      entityId: this.linkedBot.entity.id,
      metadata: [
        { key: 0, type: 1, value: 0 },
        { key: 10, type: 1, value: 15869230 },
      ],
    });
  }

  public revertToBotGamemode(client: Client) {
    const a = packetAbilities(this.linkedBot);
    console.log(a)
    if (this.linkedBot.game.gameMode === "survival") a.flags = 0; // hotfix
    const notchGM = gameModeToNotchian(this.linkedBot.game.gameMode);
    this.writeRaw(client, "abilities", a);
    this.writeRaw(client, "player_info", { action: 4, data: [{ uuid: client.uuid, gamemode: notchGM }] });
    // this.addToTab(client, 0, client.uuid, client.username, client.profile.properties)

    // https://wiki.vg/index.php?title=Protocol&oldid=14204#Change_Game_State
    this.writeRaw(client, "game_state_change", { reason: 3, gameMode: notchGM });
    this.writeRaw(client, "abilities", a);
    this.writeRaw(client, "position", {
      ...this.linkedBot.entity.position,
      yaw: this.linkedBot.entity.yaw,
      pitch: this.linkedBot.entity.pitch,
      onGround: this.linkedBot.entity.onGround,
    });

    this.makeVisible(client);
  }

  public revertToBotStatus(client: Client) {
    this.linkedFakeBot.unsubscribe(client);
    this.revertPov(client);
    this.revertToBotGamemode(client);
  }

  public linkToBotPov(client: Client) {
    if (this.clientsInCamera[client.uuid]) {
      console.warn("Already in the camera", client.username);
      this.unregister(client);
    }

    this.makeSpectator(client);

    this.writeRaw(client, "camera", {
      cameraId: this.linkedFakeBot.entityRef.id,
    });
    const updatePos = () => {
      this.writeRaw(client, "position", {
        ...this.linkedFakeBot.entityRef.knownPosition,
        yaw: 180 - (this.linkedFakeBot.entityRef.yaw * 180) / Math.PI,
        pitch: -(this.linkedFakeBot.entityRef.pitch * 180) / Math.PI,
      });
    };

    updatePos();
    const onMove = () => updatePos();
    const cleanup = () => {
      this.linkedBot.removeListener("move", onMove);
      this.linkedBot.removeListener("end", cleanup);
      client.removeListener("end", cleanup);
    };
    this.linkedBot.on("move", onMove);
    this.linkedBot.once("end", cleanup);
    client.once("end", cleanup);
    this.register(client, cleanup);
    return true;
  }

  register(client: Client, cleanup: () => void = () => {}) {
    if (this.clientsInCamera[client.uuid]) {
      this.clientsInCamera[client.uuid].cleanup();
    }
    this.clientsInCamera[client.uuid] = new GhostInfo(client, cleanup);
  }

  unregister(client: Client) {
    if (this.clientsInCamera[client.uuid]) {
      this.clientsInCamera[client.uuid].cleanup();
    }
    delete this.clientsInCamera[client.uuid];
  }
}

function writeRaw(
  this: {
    positionTransformer?: IPositionTransformer;
  },
  client: Client,
  name: string,
  data: any
) {
  if (this.positionTransformer != null) {
    const result = this.positionTransformer.onSToCPacket(name, data);
    if (!result) return;
    if (result && result.length > 1) return;
    const [transformedName, transformedData] = result[0];
    client.write(transformedName, transformedData);
  } else {
    client.write(name, data);
  }
}

function getPositionData(this: { yaw: number; pitch: number; onGround: boolean; pos: Vec3 }) {
  return {
    ...this.pos,
    yaw: this.yaw,
    pitch: this.pitch,
    onGround: this.onGround,
  };
}

type Bot = VanillaBot & { recipes: number[] };

class SpectatorInfo {
  private _status: boolean;

  public get status() {
    return this._status;
  }

  public set status(val: boolean) {
    this.cleanup();
    this._status = val;
  }

  public readonly client: Client;
  public position: Vec3 = new Vec3(0, 0, 0);
  public yaw: number = 0;
  public pitch: number = 0;
  public onGround: boolean = false;
  public readonly cleanup: () => void;
  constructor(client: Client, position: Vec3, status: boolean = false, cleanup: () => void = () => {}) {
    this.client = client;
    this.cleanup = cleanup;
    this.position = position;
    this._status = status;

    this.client.on("packet", this.posListener);
  }

  posListener = (data: any, meta: PacketMeta) => {
    if (meta.name.includes("position")) {
      this.position = new Vec3(data.x, data.y, data.z);
      this.onGround = data.onGround;
    }
    if (meta.name.includes("look")) {
      this.yaw = data.yaw;
      this.pitch = data.pitch;
      this.onGround = data.onGround;
    }
  };
}

export class FakeSpectator {
  bot: Bot;
  clientsInCamera: Record<string, SpectatorInfo> = {};
  positionTransformer?: IPositionTransformer;
  constructor(bot: Bot, options: { positionTransformer?: IPositionTransformer } = {}) {
    this.bot = bot;
    this.positionTransformer = options.positionTransformer;
  }

  private writeRaw(client: ServerClient | Client, name: string, data: any) {
    if (this.positionTransformer != null) {
      const result = this.positionTransformer.onSToCPacket(name, data);
      if (!result) return;
      if (result && result.length > 1) return;
      const [transformedName, transformedData] = result[0];
      client.write(transformedName, transformedData);
    } else {
      client.write(name, data);
    }
  }

  makeSpectator(client: ServerClient) {
    this.writeRaw(client, "player_info", {
      action: 1,
      data: [
        {
          uuid: client.uuid,
          gamemode: 3,
        },
      ],
    });
    this.writeRaw(client, "game_state_change", {
      reason: 3, // https://wiki.vg/index.php?title=Protocol&oldid=14204#Change_Game_State
      gameMode: 3,
    });
    this.writeRaw(client, "abilities", {
      flags: 7,
      flyingSpeed: 0.05000000074505806,
      walkingSpeed: 0.10000000149011612,
    });
  }

  revertToNormal(client: ServerClient) {
    this.writeRaw(client, "position", {
      ...this.bot.entity.position,
      yaw: this.bot.entity.yaw,
      pitch: this.bot.entity.pitch,
      onGround: this.bot.entity.onGround,
    });
    const a = packetAbilities(this.bot);
    this.writeRaw(client, "abilities", a);
    this.writeRaw(client, "game_state_change", {
      reason: 3, // https://wiki.vg/index.php?title=Protocol&oldid=14204#Change_Game_State
      gameMode: gameModeToNotchian(this.bot.game.gameMode),
    });
  }

  tpToFakePlayer(client: Client | ServerClient) {
    this.writeRaw(client, "position", {
      ...this.bot.entity.position,
    });
  }

  tpToCoords(client: Client | ServerClient, x?: number, y?: number, z?: number) {
    console.log({
      x: x && !isNaN(x) ? x : this.clientsInCamera[client.uuid].position.x,
      y: y && !isNaN(y) ? y : this.clientsInCamera[client.uuid].position.y,
      z: z && !isNaN(z) ? z : this.clientsInCamera[client.uuid].position.z,
      // yaw: this.clientsInCamera[client.uuid].yaw,
      // pitch: this.clientsInCamera[client.uuid].pitch,
      // onGround: this.clientsInCamera[client.uuid].onGround
    });
    this.writeRaw(client, "position", {
      x: x && !isNaN(x) ? x : this.clientsInCamera[client.uuid].position.x,
      y: y && !isNaN(y) ? y : this.clientsInCamera[client.uuid].position.y,
      z: z && !isNaN(z) ? z : this.clientsInCamera[client.uuid].position.z,
      yaw: this.clientsInCamera[client.uuid].yaw,
      pitch: this.clientsInCamera[client.uuid].pitch,
      onGround: this.clientsInCamera[client.uuid].onGround,
    });
  }

  register(client: Client | ServerClient, status: boolean = false, cleanup: () => void = () => {}) {
    this.clientsInCamera[client.uuid]?.cleanup();
    this.clientsInCamera[client.uuid] = new SpectatorInfo(client, this.bot.entity.position.clone(), status, cleanup);
  }

  unregister(client: Client | ServerClient) {
    this.register(client, false, () => {});
  }

  makeViewingBotPov(client: Client | ServerClient) {
    if (this.clientsInCamera[client.uuid]) {
      if (this.clientsInCamera[client.uuid].status) {
        console.warn("Already in the camera", client.username);
        return false;
      }
    } else {
      this.register(client);
    }

    this.writeRaw(client, "camera", {
      cameraId: FakeBotEntity.id,
    });
    const updatePos = () => {
      this.writeRaw(client, "position", {
        ...this.bot.entity.position,
        yaw: 180 - (this.bot.entity.yaw * 180) / Math.PI,
        pitch: -(this.bot.entity.pitch * 180) / Math.PI,
        onGround: this.bot.entity.onGround,
      });
    };
    updatePos();
    const onMove = () => updatePos();
    const cleanup = () => {
      this.bot.removeListener("move", onMove);
      this.bot.removeListener("end", cleanup);
      client.removeListener("end", cleanup);
    };
    this.bot.on("move", onMove);
    this.bot.once("end", cleanup);
    client.once("end", cleanup);
    this.register(client, true, cleanup);
    return true;
  }

  revertPov(client: Client | ServerClient) {
    if (!this.clientsInCamera[client.uuid]) return false;
    if (!this.clientsInCamera[client.uuid].status) return false;
    this.writeRaw(client, "camera", {
      cameraId: this.bot.entity.id,
    });
    this.unregister(client);
    return true;
  }
}

function gamemodeToNumber(str: GameState["gameMode"]) {
  if (str === "survival") {
    return 0;
  } else if (str === "creative") {
    return 1;
  } else if (str === "adventure") {
    return 2;
  } else if (str === "spectator") {
    return 3;
  }
}
