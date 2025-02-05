import antiAFK, {
  AllModuleSettings,
  AllPassiveSettings,
  DEFAULT_MODULES,
  DEFAULT_PASSIVES,
  unloadDefaultModules
} from '@nxg-org/mineflayer-antiafk'
import {loader as autoEat} from '@nxg-org/mineflayer-auto-eat'
import {
  MODULE_DEFAULT_SETTINGS,
  PathfinderWalkOpts,
  BoxWalk,
  BoxWalkOpts,
  SwingArm
} from '@nxg-org/mineflayer-antiafk/lib/modules'
import { Conn } from '@generelschwerz/mcproxy'
import { Bot } from 'mineflayer'
import { pathfinder } from 'mineflayer-pathfinder'
import { PacketQueuePredictor, PacketQueuePredictorEvents } from './predictors/packetQueuePredictor'
import { CombinedPredictor } from './predictors/combinedPredictor'
import { IProxyServerOpts, IProxyServerEvents, ProxyServerPlugin } from '@nxg-org/mineflayer-mitm-proxy'
import { once } from 'events'

export interface TwoBAntiAFKOpts {
  antiAFK: {
    enabled: boolean
    modules: Partial<AllModuleSettings>
    passives: Partial<AllPassiveSettings>
  }
  autoEat: boolean
}

export interface TwoBAntiAFKEvents extends PacketQueuePredictorEvents {}

export class TwoBAntiAFKPlugin extends ProxyServerPlugin<TwoBAntiAFKOpts, {}, TwoBAntiAFKEvents> {
  name = 'AntiAFK'

  private _queue?: PacketQueuePredictor<any, any>
  public get queue () {
    return this._queue
  }

  onPreStart(conn: Conn) {
    this._queue = new CombinedPredictor(conn)
    this._queue.begin()
    this._queue.on('*', (...args: any[]) => {
      this.serverEmit((this._queue as any).event, ...args);
    })
    this.share('queue', this._queue)
  }

  onPreStop() {
    if (this._queue != null) this._queue.end()
    this.drop('queue')
  }

  async onInitialBotSetup(bot: Bot) {
    // console.log(this.psOpts.antiAFK.enabled, (bot as any).antiAfk, antiAFK)
    if (this.psOpts.antiAFK.enabled) {
      await once(bot, 'inject_allowed')
      bot.loadPlugin(pathfinder)
      bot.loadPlugin(antiAFK)
      unloadDefaultModules(bot)
      

      bot.antiafk.on('moduleCanceled', (mod) =>
        this.serverLog('AntiAFK!', `[ERROR] Canceled AntiAFK module: ${mod.constructor.name}`)
      )

      bot.antiafk.on('moduleCompleted', (mod, success, reason) =>
        this.serverLog(
          'AntiAFK!',
          `[INFO] Completed AntiAFK module: ${mod.constructor.name}, to success: ${success}, with reason: ${reason}`
        )
      )

      if (DEFAULT_MODULES.BlockBreak != null && this.psOpts.antiAFK.modules.PathfinderWalk != null) {
        if (this.server.bOpts.host?.includes('2b2t')) {
          bot.antiafk.setOptionsForModule(DEFAULT_MODULES.PathfinderWalk, PathfinderWalkOpts.TwoBTwoT(bot))
        }

        bot.antiafk.addModules(DEFAULT_MODULES.PathfinderWalk)
        bot.antiafk.setOptionsForModule(DEFAULT_MODULES.PathfinderWalk, this.psOpts.antiAFK.modules.PathfinderWalk)
      }

      if (DEFAULT_MODULES.BlockBreak != null && this.psOpts.antiAFK.modules.BlockBreak != null) {
        bot.antiafk.addModules(DEFAULT_MODULES.BlockBreak)
        bot.antiafk.setOptionsForModule(DEFAULT_MODULES.BlockBreak, this.psOpts.antiAFK.modules.BlockBreak)
      }

      if (this.psOpts.antiAFK.modules.RandomMovement != null) {
        bot.antiafk.addModules(DEFAULT_MODULES.RandomMovement)
        bot.antiafk.setOptionsForModule(DEFAULT_MODULES.RandomMovement, this.psOpts.antiAFK.modules.RandomMovement)
      }

      if (this.psOpts.antiAFK.modules.LookAround != null) {
        bot.antiafk.addModules(DEFAULT_MODULES.LookAround)
        bot.antiafk.setOptionsForModule(DEFAULT_MODULES.LookAround, this.psOpts.antiAFK.modules.LookAround)
      }

      if (this.psOpts.antiAFK.modules.ChatBot != null) {
        bot.antiafk.addModules(DEFAULT_MODULES.ChatBot)
        bot.antiafk.setOptionsForModule(DEFAULT_MODULES.ChatBot, this.psOpts.antiAFK.modules.ChatBot)
      }

    
      if (this.psOpts.antiAFK.modules.BoxWalk != null) {
        bot.antiafk.addModules(BoxWalk)
        bot.antiafk.setOptionsForModule(BoxWalk, this.psOpts.antiAFK.modules.BoxWalk)
      }

      if (this.psOpts.antiAFK.modules.SwingArm != null) {
        bot.antiafk.addModules(SwingArm)
        bot.antiafk.setOptionsForModule(SwingArm, this.psOpts.antiAFK.modules.SwingArm)
      }

      // passives
      if (this.psOpts.antiAFK.passives.KillAura != null) {
        bot.antiafk.setOptionsForPassive(DEFAULT_PASSIVES.KillAura, this.psOpts.antiAFK.passives.KillAura)
      }
    }

    if (this.psOpts.autoEat) {
      bot.loadPlugin(autoEat)

      bot.autoEat.setOpts({
        strictErrors: false // errors will be printed instead of throwing for the bot.s
      })
    }
  }

  onBotAutonomous(bot: Bot) {
    if (this._queue == null) throw Error('Somehow bot is starting without queue being initialized!')
    if (this.psOpts.antiAFK && !this._queue.inQueue) bot.antiafk.start()
    if (this.psOpts.autoEat && !this._queue.inQueue) bot.autoEat.enableAuto()
  }

  onBotControlled(bot: Bot) {
    if (this.psOpts.antiAFK) bot.antiafk.forceStop()
    if (this.psOpts.autoEat) bot.autoEat.disableAuto()
  }
}
