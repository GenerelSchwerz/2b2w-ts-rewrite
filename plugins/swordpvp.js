const { ProxyServerPlugin } = require("@nxg-org/mineflayer-mitm-proxy");
const { pathfinder } = require("mineflayer-pathfinder");
const { default: customPVP } = require("@nxg-org/mineflayer-custom-pvp");
const { loader: autoEat } = require("@nxg-org/mineflayer-auto-eat");

/**
 * Gen here again.
 *
 * Example plugin to go from point A to point B.
 *
 * I will include this plugin in the main project as a POC.
 *
 * Note: this does not leverage the spectator setting present in most of the proxy.
 *  That is because that is a separate plugin. That is intentional.
 *  This is purposefully simple so it can be easy to follow.
 *
 */
class SwordPVPPlugin extends ProxyServerPlugin {
  
  // rough patch
  opts = {
    attackRange: 32
  }
  
  connectedCmds = {

    swordpvp: {
      attack: {
        usage: "<name>",
        description: "Attack entity with identifier",
        callable: this.attack.bind(this),
      },
  
      stop: {
        description: "stop attacking",
        callable: this.stop.bind(this),
      },
  
      range: {
        description: "set attack range",
        callable: this.setRange.bind(this),
      },
    }
  
  };

  wantedTarget = null;

  onInitialBotSetup(bot) {
    bot.loadPlugin(pathfinder);
    bot.loadPlugin(customPVP);
    bot.loadPlugin(autoEat);
  };

  setRange(client, rnge) {
    const range = Number(rnge)
    if (Number.isNaN(range)) return this.server.message(client, "Range is not a number!")
    this.opts.attackRange = range;
    this.server.message(client, `Range has been set to: ${range} blocks!`)
  }

  setupAttack(client) {
    const bot = this.server.remoteBot;

    this.server.endBotLogic();
    bot.autoEat.enableAuto();

    const oldOffhand = bot.autoEat.opts.offhand;
    bot.autoEat.setOpts({offhand: true}) 

    const listener = () => {
      const e = bot.nearestEntity(
        e => (e.username?.includes(this.wantedTarget) || 
        e.name?.includes(this.wantedTarget)) &&
        e.position.distanceTo(bot.entity.position) < this.opts.attackRange
      );
      if (e == null) {
        console.log("Could not find entity with identifier: ", this.wantedTarget)
        this.server.message(client, `Could not find entity with identifier: ${this.wantedTarget}`);
        bot.off("physicsTick", listener);
        this.stop(client);
        bot.autoEat.setOpts({offhand: oldOffhand})
        this.server.beginBotLogic();
        return;
      }

      switch (e.type) {
        case "player":
          bot.swordpvp.options.followConfig.distance = 3;
          bot.swordpvp.options.tapConfig.mode = "stap";
          bot.swordpvp.options.genericConfig.tooCloseRange = 1.5;
          break;
        case "mob":
        default:
          bot.swordpvp.options.followConfig.distance = 3;
          bot.swordpvp.options.tapConfig.mode = "stap";
          bot.swordpvp.options.genericConfig.tooCloseRange = e.name === "skeleton" ? 0 : 2.5;
          break;
      }

      if (!bot.swordpvp.target || !bot.swordpvp.target.isValid) 
        bot.swordpvp.attack(e);
      else {
        const dist = bot.entity.position.distanceTo(e.position);
        if (dist < bot.swordpvp.target.position.distanceTo(bot.entity.position))  {
            const maxticks = bot.swordpvp.meleeAttackRate.getTicks(bot.heldItem) - 1
            if (bot.swordpvp.ticksToNextAttack >= maxticks || bot.swordpvp.ticksToNextAttack == 0)
                bot.swordpvp.attack(e);
        }
      }
    };

    bot.on("physicsTick", listener);
  }

  async attack(client, ident) {

    this.wantedTarget = ident;

    const e = this.server.remoteBot.nearestEntity(
        (e) => e.username?.includes(ident) || e.name?.includes(ident));

    if (e == null) 
      return this.server.message(client, `Could not find entity with identifier: ${this.wantedTarget}`);

    const dist = e.position.distanceTo(this.server.remoteBot.entity.position);
    if (dist > this.opts.attackRange) 
      return this.server.message(client, `Entity "${this.wantedTarget}" is too far away! ${dist.toFixed(2)} blocks away.`);


    this.server.message(client, `Attacking entity: ${ident}`);
    this.unlink(client);
    if (!this.server.remoteBot.swordpvp.target) this.setupAttack(client);
  }

  async stop(client) {
    this.wantedTarget = null;
    const attacking = this.server.remoteBot.swordpvp.target;
    this.server.remoteBot.swordpvp.stop();
    if (attacking) this.link(client)
    this.server.message(client, `Stopping sword pvp!`);
  }
}

module.exports = new SwordPVPPlugin();
