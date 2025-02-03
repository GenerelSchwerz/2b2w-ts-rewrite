Error.stackTraceLimit = 30
import * as fs from "fs";
import path from "path";
import { validateOptions } from "./util/config";
import { botOptsFromConfig, serverOptsFromConfig } from "./util/options";
import {
  ConsoleReporter,
  SpectatorServerPlugin,
  TwoBAntiAFKPlugin,
  WebhookReporter,
  MotdReporter,
} from "./localServer";
import { ServerBuilder } from "@nxg-org/mineflayer-mitm-proxy";
import { buildClient } from "./discord";
import type { Options } from "./types/options";
import { RestartPlugin, SecurityPlugin } from "./localServer/security";
import { Task, sleep } from "./util";

import detectTSNode from "detect-ts-node";

import rl from "readline";
import { once } from "events";

if (process.version.split("v")[1].split(".")[0] != "18") {
  console.log("Your version of node is incorrect. This program only functions on Node16.");
  console.log(`Your node version is: ${process.version}`);
  console.log("This is an issue with node-minecraft-protocol, so annoy them. Not me.");
  process.exit(1);
}

const yaml = require("js-yaml");

// ... If no errors were found, return the validated config
let config;

try {
  config = yaml.load(fs.readFileSync("./options.yml", "utf-8"));
} catch (e) {
  const data = fs.readFileSync("./static/defaults/default_config.yml", "utf-8");
  fs.writeFileSync("./options.yml", data);
  config = yaml.load(data);
  console.warn("No config detected, so loading default one. This will crash, so fill it out.");
}

const checkedConfig: Options = validateOptions(config);
const bOpts = botOptsFromConfig(checkedConfig);

async function setup() {
  // ==================
  //   Server setup
  // ==================

  const serverOptions = await serverOptsFromConfig(checkedConfig);

  const server = new ServerBuilder(serverOptions, bOpts)

    // add plugins that provide events here!

    .addPlugin(new SecurityPlugin())
    .addPlugin(new RestartPlugin())
    .addPlugin(new SpectatorServerPlugin())
    .addPlugin(new TwoBAntiAFKPlugin())
    .addPlugin(new MotdReporter())
    

    // apply settings only after all plugins have been loaded!
    .setSettings({
      pluginFolder: checkedConfig.pluginFolder, // temporary hotfix
      ...checkedConfig.localServerConfig,
    } as any)
    .setOtherSettings({
      loggerOpts: checkedConfig.logger,
    })
    .build();

  // all other plugins must be listener-only to be strongly typed.
  // This is to prevent improperly built servers.
  if (true) {
    server.loadPlugin(new ConsoleReporter());
  }

  if (checkedConfig.discord.webhooks?.enabled) {
    server.loadPlugin(new WebhookReporter(checkedConfig.discord.webhooks));
  }

  // if (checkedConfig.discord.bot?.enabled) {
  //   buildClient(checkedConfig.discord.bot, server);
  // }

  // ==========================
  //   Dynamic plugin loading
  // ==========================

  // Added support for external plugins.

  if (checkedConfig.pluginFolder) {
    if (checkedConfig.pluginFolder.startsWith("."))
      checkedConfig.pluginFolder = path.join(process.cwd(), checkedConfig.pluginFolder);
    const f = checkedConfig.pluginFolder;

    if (!fs.existsSync(f)) {
      fs.mkdirSync(f);
      console.warn("Plugin folder was not present. Made a new folder instead.");
    } else
      await Promise.all(
        fs.readdirSync(f).map(async (file) => {
          const file1 = path.join(f, file);
          const filetype = file1.split(".")[file1.split(".").length - 1];

          switch (filetype) {
            case "js":
              const data0 = await require(file1);
              server.loadPlugin(data0);
              break;
            case "ts":
              if (!detectTSNode)
                throw Error(
                  "Typescript plugin loaded at runtime when running with JavaScript!\n" +
                    'To load typescript plugins, run this program with "npm run ts-start"'
                );
              const data1 = await require(file1);
              server.loadPlugin(data1.default);
              break;
          }
        })
      );
  }

  // server.on('started', (conn) => conn.stateData.bot._client.on('player_info', console.log))

  // ===============================
  //   Process interrupt handling
  // ===============================

  let stopTask = Task.createDoneTask();
  process.on("SIGINT", async () => {
    if (server.isProxyConnected()) {
      if (!stopTask.done) return await stopTask.promise;
      stopTask = Task.createTask();
      console.log("Recieved interrupt, shutting down (wait 5 seconds for termination).");
      server.close();
      await once(server, "closed");
      stopTask.finish();
    }

    process.exit(0);
  });

  // ===========================
  //   Command-line Handling
  // ===========================

  const handler = rl.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  handler.on("line", (line) => {
    const [cmd, ...args] = line.trim().split(" ");

    switch (cmd) {
      case "help":
        console.log("----------- Help Message ---------");
        console.log("help: this message");
        console.log("start: starts the server");
        console.log("stop: stops the server");
        console.log("clear <#>: clear terminal (of <#> lines or all)");
        return;

      case "start":
        console.log("Starting the server.");
        return server.start();

      case "stop":
        console.log("Stopping the server.");
        return server.stop();

      case "clear":
        const num0 = args[0] ? -Number(args[0]) : -100;
        rl.moveCursor(process.stdout, 0, num0);
        rl.clearScreenDown(process.stdout);
        console.log("cleared screen");
        return;

      case "status": {
        return console.log();
      }
    }
  });

  if (checkedConfig.startImmediately) {
    server.start();
  }

  // ==========================
  //  custom logging example!
  // ==========================

  // server.on('botevent_move', (bot, pos) => {
  //   server.logger.log('botMovement', 'custom', pos)
  // })
}

setup();
