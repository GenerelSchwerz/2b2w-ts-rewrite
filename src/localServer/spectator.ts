import { ProxyServerPlugin, CommandMap, CmdPerm } from "@nxg-org/mineflayer-mitm-proxy";
import { Client as ProxyClient, Conn, PacketMiddleware } from "@GenerelSchwerz/mcproxy";
import { Client } from "minecraft-protocol";
import { WorldManager } from "./spectatorUtils";
import { FakeBotEntity, GhostHandler } from "./ghostUtils/fakes";

const sleep = (ms: number) => new Promise((res, rej) => setTimeout(res, ms));

export interface SpectatorServerOpts {
  linkOnConnect: boolean;
  worldCaching: boolean;
}

export interface SpectatorServerEvents {
  clientChatRaw: (pclient: Client, message: string) => void;
  clientChat: (pclient: Client, message: string) => void;
}

export class SpectatorServerPlugin extends ProxyServerPlugin<SpectatorServerOpts, {}, SpectatorServerEvents> {
  public static readonly notControllingBlockedPackets: string[] = ["entity_metadata", "abilities", "position"];

  public worldManager: WorldManager | null = null;
  public fakeSpectator: GhostHandler | null = null;
  public fakePlayer: FakeBotEntity | null = null;

  connectedCmds: CommandMap = {
    link: {
      description: "Link player to remote bot instance",
      allowedIf: CmdPerm.UNLINKED,
      callable: this.link.bind(this),
    },
    unlink: {
      description: "Unlink player from remote bot instance",
      allowedIf: CmdPerm.LINKED,
      callable: this.unlink.bind(this),
    },

    c: {
      usage: "<string>",
      description: "Chat with other players connected to your proxy",
      callable: (client, ...args) => this.server.broadcastMessage(`[${client.username}] ${args.join(" ")}`),
    },

    stopbot: {
      description: "Stops the bot's remote control",
      allowedIf: CmdPerm.UNLINKED,
      callable: (client) => {
        if (this.server.isPlayerControlling()) return this.server.message(client, "Bot is not running.");
        this.server.endBotLogic();
      },
    },
    startbot: {
      description: "Starts the bot's remote control",
      allowedIf: CmdPerm.UNLINKED,
      callable: (client) => {
        if (!this.server.isPlayerControlling()) return this.server.message(client, "Bot is already in control.");
        this.server.beginBotLogic();
      },
    },

    view: {
      description: "Link the spectating player's perspective",
      allowedIf: CmdPerm.UNLINKED,
      callable: (client) => {
        const res0 = this.makeViewFakePlayer(client);
        if (res0) this.server.message(client, "Connecting to view. Type /unview to exit");
      },
    },

    unview: {
      description: "Unlink the spectating player's perspective",
      allowedIf: CmdPerm.UNLINKED,
      callable: (client) => {
        const res1 = this.makeViewNormal(client);
        if (res1) this.server.message(client, "Disconnecting from view. Type /view to connect");
      },
    },

    tpto: {
      description: "Tp to the bot's location",
      allowedIf: CmdPerm.UNLINKED,
      callable: (client, ...args) => {
        if (client.uuid === this.server.conn?.pclient?.uuid) {
          this.server.message(client, "Cannot tp. You are controlling the bot.");
          return;
        }

        if (this.fakeSpectator?.clientsInCamera[client.uuid] != null) {
          this.server.message(client, "You are viewing the bot's perspective.");
        }

        this.fakeSpectator?.revertPov(client);
        this.fakeSpectator?.tpToFakePlayer(client);
      },
    },
  };

  onProxySetup = (conn: Conn): void => {
    const data = conn.toClientDefaultMiddleware != null ? conn.toClientDefaultMiddleware : [];
    const data1 = conn.toServerDefaultMiddleware != null ? conn.toServerDefaultMiddleware : [];
    conn.toClientDefaultMiddleware = [...this.genToClientMiddleware(conn), ...data];
    conn.toServerDefaultMiddleware = [...this.genToServerMiddleware(conn), ...data1];
    if (conn.stateData.bot.entity) {
      this.buildFakeData(conn);
    } else {
      conn.stateData.bot.once("login", () => {
        this.buildFakeData(conn);
      });
    }
  };

  // ======================= //
  //     server utils        //
  // ======================= //

  private buildFakeData(conn: Conn) {
    this.fakePlayer = new FakeBotEntity(conn.stateData.bot as any, {
      username: "[B] " + conn.stateData.bot.username.substring(0, 12),
      // uuid: conn.stateData.bot._client.uuid,
      positionTransformer: conn.positionTransformer,
    });

    this.fakeSpectator = new GhostHandler(this.fakePlayer);
    this.fakePlayer.sync();
    conn.stateData.bot.once("end", () => {
      this.fakePlayer?.unsync();
    });
  }

  public async sendPackets(client: Client) {
    while (this.server.remoteBot?.entity == null) {
      await sleep(100);
    }
    this.server.conn?.sendPackets(client as ProxyClient);
  }

  public override whileConnectedLoginHandler = async (client: Client) => {
    if (this.server.remoteBot == null) return true;
    if (this.server.conn == null) return true;

    if (this.worldManager != null) {
      const managedPlayer = this.worldManager.newManagedPlayer(client, this.server.remoteBot.entity.position);
      managedPlayer.loadChunks(this.server.remoteBot.world);
      managedPlayer.awaitPosReference(this.server.remoteBot);

      this.server.conn.attach(client as unknown as ProxyClient, {
        toClientMiddleware: managedPlayer.getMiddlewareToClient(),
      });
    } else {
      this.server.conn.attach(client as unknown as ProxyClient);
    }

    await this.sendPackets(client);
    const connect = this.server.psOpts.linkOnConnect && this.server.conn?.pclient == null;
    if (connect) {
      this.fakeSpectator!.makeSpectator(client);
      this.fakeSpectator!.register(client);
      if (this.server.controllingPlayer == null) {
        this.server.beginBotLogic();
      }
    } else {
      this.link(client);
    }

    this.server.runCmd(client, "phelp");

    client.once("end", () => {
      if (this.server.conn !== null) {
        if (client === this.server.controllingPlayer) this.server.beginBotLogic();
        this.unlink(client);
      }
      this.fakeSpectator?.unregister(client);
    });

    return true;
  };

  link(client: Client) {
    if (this.server.controllingPlayer == null) {
      this.server.message(client, "Linking");
      super.link(client);
    } else this.server.message(client, `Cannot link. User §3${this.server.controllingPlayer.username}:§r is linked.`);
  }

  async onLinking(client: Client) {
    if (client === this.server.controllingPlayer) {
      this.server.message(client, "Already in control, cannot link!");
      return;
    }

    if (this.server.controllingPlayer == null) {
      this.fakeSpectator?.revertToBotStatus(client);
    }
  }

  unlink(client: Client) {
    if (client !== this.server.controllingPlayer) {
      this.server.message(client, "Cannot unlink as not in control!");
      return;
    }

    this.server.message(client, "Unlinking");
    super.unlink(client);
  }

  onUnlinking(client: Client): void {
    if (client == null) return;
    this.fakeSpectator?.makeSpectator(client);
  }

  makeViewFakePlayer(client: Client) {
    if (client === this.server.conn?.pclient) {
      this.server.message(client, "Cannot get into the view. You are controlling the bot");
      return;
    }
    if (this.fakeSpectator == null) return false;

    return this.fakeSpectator.linkToBotPov(client);
  }

  makeViewNormal(client: Client) {
    if (client === this.server.conn?.pclient) {
      this.server.message(client, "Cannot get out off the view. You are controlling the bot");
      return;
    }
    if (this.fakeSpectator == null) return false;
    return this.fakeSpectator.revertPov(client);
  }

  // ======================= //
  //        bot utils        //
  // ======================= //

  private genToClientMiddleware(conn: Conn) {
    const inspector_toClientMiddleware: PacketMiddleware = ({ meta, data, isCanceled, bound }) => {
      if (conn == null || isCanceled || bound !== "client") return;
      if (!this.server.isPlayerControlling() && SpectatorServerPlugin.notControllingBlockedPackets.includes(meta.name)) {
      }
    };

    const inspector_toClientFakePlayerSync: PacketMiddleware = ({ isCanceled, pclient, data, meta }) => {
      if (isCanceled || pclient === conn?.pclient) return;
      if (conn == null) return;
      if (data.collectorEntityId === conn.stateData.bot.entity?.id) {
        switch (meta.name) {
          case "collect":
            data.collectorEntityId = FakeBotEntity.id;
            break;
          case "entity_metadata":
            data.entityId = FakeBotEntity.id;
            break;
          case "entity_update_attributes":
            data.entityId = FakeBotEntity.id;
            break;
        }
      }
      if (data.entityId === conn.stateData.bot.entity?.id) {
        switch (meta.name) {
          case "entity_velocity":
            data.entityId = FakeBotEntity.id;
            return; // can't sim, so might as well ignore for now.
        }
      }
      return data;
    };

    const inspector_toClientMiddlewareRecipesFix: PacketMiddleware = ({ meta, data, bound, isCanceled }) => {
      if (isCanceled) return;
      if (bound !== "client") return;
      if (meta.name === "unlock_recipes") {
      }
    };

    return [inspector_toClientMiddleware, inspector_toClientFakePlayerSync, inspector_toClientMiddlewareRecipesFix];
  }

  private genToServerMiddleware(conn: Conn) {
    const inspector_toServerMiddleware: PacketMiddleware = ({ meta, pclient, data, isCanceled }) => {
      if (conn == null || pclient == null) return;
      switch (meta.name) {
        case "use_entity":
          if (this.fakeSpectator == null) return data;
          if (this.fakeSpectator.clientsInCamera[pclient.uuid] != null) return data;

          if (data.target === this.fakeSpectator.linkedFakeBot.entityRef.id) {
            if (data.mouse === 0 || data.mouse === 1) {
              this.fakeSpectator.linkToBotPov(pclient);
            }
          }
          break;
      }
    };

    return [inspector_toServerMiddleware];
  }
}
