import mc from "minecraft-protocol";
import { ServerOptions } from "minecraft-protocol";

import EventEmitter from "events";
import path from "path";
import fs from "fs";

import type { Bot, BotOptions } from "mineflayer";

import {
  BaseCommand,
  isBaseCommand,
  QueueCommand,
} from "./constants.js";
import { ProxyLogic } from "./proxyUtil/proxyLogic.js";
import { IProxyServerOpts } from "./proxyUtil/proxyServer.js";
import { QueuePlugin, QueueResult } from "./mineflayerPlugins/queueFollower.js";
import merge from "ts-deepmerge";

export class QueueHandler extends ProxyLogic {

  public get queuePos() {
    return this.proxyServer.remoteBot.queuePlugin.currentPosition;
  }

  public get queueHistory() {
    return this.proxyServer.remoteBot.queuePlugin.positionHistory;
  }


  private get queuePlugin() {
    return this.proxyServer.remoteBot.queuePlugin;
  }

  public constructor(
    bOptions: BotOptions,
    sOptions: ServerOptions,
    psOptions: Partial<IProxyServerOpts> = {}
  ) {
    super(bOptions, sOptions, psOptions);
  }

  public override async handleCommand(
    command: QueueCommand | BaseCommand,
    ...args: any[]
  ) {
    if (isBaseCommand(command)) {
      return super.handleCommand(command, ...args);
    }
    switch (command) {
      case "qpos":
        return this.queuePos;
      case "qhistory":
        return this.queueHistory;
      case "qinfo":
        return this.getQueueInfo();
    }
  }

  public override start() {
    super.start();
    const inject = QueuePlugin.makeInjection();
    this.proxyServer.remoteBot.loadPlugin(inject);
    return true;
  }


  public getQueueInfo(): QueueResult & {currentPosition: number} | {currentPosition: number} {
    const summarize: any = this.queuePlugin.summarize() || {};
    summarize.currentPosition = this.queuePos;
    return summarize;
  }

}
