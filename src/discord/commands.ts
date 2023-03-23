import { CommandInteraction, OAuth2Scopes, ApplicationCommandOptionType } from "discord.js";

import { Client, Discord, Slash, SlashGroup, SlashOption } from "discordx";
import { DateTime, Duration } from "ts-luxon";
import { hourAndMinToDateTime, pingTime, tentativeStartTime } from "../util/remoteInfo";

@Discord()
@SlashGroup({ description: "Queue related commands", name: "queue" })
@SlashGroup("queue")
export class QueueCommands {
  @Slash({ description: "Get queue position." })
  async pos(
    
    @SlashOption({
      description: "specific username",
      name: "username",
      required: false,
      type: ApplicationCommandOptionType.String,
    })
    username: string = '/0all',
    interaction: CommandInteraction, client: Client) {
    // lazy, don't care anymore.
    const mcServer = client.mcServer;

    if (!mcServer.isProxyConnected()) {
      return await interaction.reply("We are not connected to the server!");
    }

    if (username !== '/0all') {
      // do not reply w/ this bot instance if a username is specified AND it does not match.
      if (!mcServer.remoteBot?.username.includes(username)) return;
    }

    if (mcServer.queue == null) return await interaction.reply("No queue loaded!");

    const spot = mcServer.queue.lastPos;

    if (Number.isNaN(spot)) return await interaction.reply(`Queue position for ${mcServer.bOpts.username} unknown!.`);

    interaction.reply(`Queue pos for ${mcServer.remoteBot?.username}: ${spot}`);
  }

  @Slash({ description: "Check queue position and other additional info." })
  async info(interaction: CommandInteraction, client: Client) {
    // lazy, don't care anymore.
    const mcServer = client.mcServer;

    if (!mcServer.isProxyConnected()) {
      interaction.reply("We are not connected to the server!");
      return;
    }

    if (mcServer.queue == null) return await interaction.reply("No queue loaded!");

    let eta;
    let joiningAt;
    if (!Number.isNaN(mcServer.queue.eta)) {
      console.log(mcServer.queue.eta);
      eta = Duration.fromMillis(mcServer.queue.eta * 1000 - Date.now()).toFormat("h 'hours and' m 'minutes'");
      joiningAt = DateTime.local().plus({ seconds: mcServer.queue.eta }).toFormat("hh:mm a, MM/dd/yyyy");
    } else {
      eta = "Unknown (ETA is NaN)";
    }

    interaction.reply(`Queue pos: ${mcServer.queue.lastPos}\n` + `Queue ETA: ${eta}\n` + "Joining at: ");
  }
}

@Discord()
@SlashGroup({ description: "Local server related commands", name: "local" })
@SlashGroup("local")
export class LocalServerCommands {
  @Slash({ description: "Start local server." })
  async start(interaction: CommandInteraction, client: Client) {
    // lazy, don't care anymore.
    const mcServer = client.mcServer;

    if (mcServer.isProxyConnected()) {
      interaction.reply("We are already connected to the server!");
      return;
    }

    mcServer.start();

    interaction.reply("Server started!");
  }

  @Slash({ description: "Stop local server." })
  async stop(interaction: CommandInteraction, client: Client) {
    // lazy, don't care anymore.
    const mcServer = client.mcServer;

    if (!mcServer.isProxyConnected()) {
      interaction.reply("We are already disconnected from the server!");
      return;
    }

    mcServer.stop();

    interaction.reply("Server stopped!");
  }

  @Slash({
    description: "Attempt to start server so that the bot is ready to play at a certain time.",
  })
  async playat(
    @SlashOption({
      description: "hour value",
      name: "hour",
      required: true,
      type: ApplicationCommandOptionType.Number,
    })
    hour: number,
    @SlashOption({
      description: "minute value",
      name: "minute",
      required: true,
      type: ApplicationCommandOptionType.Number,
    })
    minute: number,
    interaction: CommandInteraction,
    client: Client
  ) {
    // lazy, don't care anymore.
    const mcServer = client.mcServer;

    if (mcServer.isProxyConnected()) {
      interaction.reply("We are already connected to the server!");
      return;
    }

    // mcServer.playat(hour, minute);

    const secondsTilStart = await tentativeStartTime(hour, minute);
    const hoursTilStart = Math.floor(secondsTilStart / 3600);
    const minutesTilStart = Math.ceil((secondsTilStart - hoursTilStart * 3600) / 60);

    const dateStart = DateTime.local().plus({ seconds: secondsTilStart });
    const data = hourAndMinToDateTime(hour, minute);
    if (secondsTilStart > 0) {
      interaction.reply(
        `To play at ${data.toFormat("MM/dd hh:mm a").toLowerCase()}, ` +
          `the server will start in ${hoursTilStart} hours and ${minutesTilStart} minutes!\n` +
          `Start time: ${dateStart.toFormat("hh:mm a, MM/dd/yyyy")}`
      );
    } else {
      interaction.reply(
        `To play at ${data.toFormat("MM/dd hh:mm a").toLowerCase()}, ` +
          "the server should right now!\n" +
          `Start time: ${DateTime.local().toFormat("hh:mm a, MM/dd/yyyy")}`
      );
    }
  }

  @Slash({
    description: "Attempt to start server so that the bot is ready to play at a certain time.",
  })
  async startwhen(
    @SlashOption({
      description: "hour value",
      name: "hour",
      required: true,
      type: ApplicationCommandOptionType.Number,
    })
    hour: number,
    @SlashOption({
      description: "minute value",
      name: "minute",
      required: true,
      type: ApplicationCommandOptionType.Number,
    })
    minute: number,
    interaction: CommandInteraction,
    client: Client
  ) {
    // lazy, don't care anymore.
    const mcServer = client.mcServer;

    if (mcServer.isProxyConnected()) {
      interaction.reply("We are already connected to the server!");
      return;
    }

    const data = hourAndMinToDateTime(hour, minute);
    const secondsTilStart = await tentativeStartTime(hour, minute);
    const hoursTilStart = Math.floor(secondsTilStart / 3600);
    const minutesTilStart = Math.ceil((secondsTilStart - hoursTilStart * 3600) / 60);

    const dateStart = DateTime.local().plus({ seconds: secondsTilStart });
    if (secondsTilStart > 0) {
      interaction.reply(
        `To play at ${data.toFormat("MM/dd hh:mm a").toLowerCase()}, ` +
          `the server should start in ${hoursTilStart} hours and ${minutesTilStart} minutes.\n` +
          `Start time: ${dateStart.toFormat("hh:mm a, MM/dd/yyyy")}`
      );
    } else {
      interaction.reply(
        `To play at ${data.toFormat("MM/dd hh:mm a").toLowerCase()}, ` +
          "the server should right now!\n" +
          `Start time: ${DateTime.local().toFormat("hh:mm a, MM/dd/yyyy")}`
      );
    }
  }
}

@Discord()
export class GeneralCommands {
  @Slash({ description: "Ping a minecraft server." })
  async ping(
    @SlashOption({
      description: "host value",
      name: "host",
      required: true,
      type: ApplicationCommandOptionType.String,
    })
    host: string,
    @SlashOption({
      description: "port value",
      name: "port",
      required: true,
      type: ApplicationCommandOptionType.Number,
    })
    port: number,
    interaction: CommandInteraction,
    client: Client
  ) {
    // lazy, don't care anymore.
    const mcServer = client.mcServer;

    if (!mcServer.isProxyConnected()) {
      interaction.reply("We are not connected to the server!");
      return;
    }

    const num = await pingTime(host, port);
    if (Number.isNaN(num)) {
      interaction.reply("There was a problem pinging the server. (Value is NaN)");
      return;
    }
    interaction.reply(`Response time was: ${num} ms.`);
  }

  @Slash({ description: "invite" })
  invite(interaction: CommandInteraction, client: Client) {
    interaction.reply(
      client.generateInvite({
        permissions: "Administrator",
        scopes: [OAuth2Scopes.Bot, OAuth2Scopes.ApplicationsCommands],
      })
    );
  }
}
