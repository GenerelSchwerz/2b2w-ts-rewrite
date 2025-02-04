import { Vec3 } from 'vec3'
import { Client, ServerClient, PacketMeta } from 'minecraft-protocol'
import { Bot as VanillaBot, GameState } from 'mineflayer'
import { performance } from 'perf_hooks'
import type { Item as ItemType } from 'prismarine-item'
import { IPositionTransformer, packetAbilities } from '@GenerelSchwerz/mcproxy'

const itemLoader = require('prismarine-item/index.js') // ncc compat, get default.
const fetch = require('node-fetch')

type Bot = VanillaBot & { recipes: number[] }

const NoneItemData = {
  blockId: -1,
  itemCount: undefined,
  itemDamage: undefined,
  nbtData: undefined
} as any

class FakeEntity {
  knownPosition: Vec3
  lastSendPos: number
  yaw: number
  pitch: number
  oldYaw: number
  oldPitch: number
  onGround: boolean
  mainHand?: object
  offHand?: object
  armor: Array<object | undefined>
  constructor (pos: Vec3, yaw: number, pitch: number) {
    this.knownPosition = pos
    this.yaw = yaw
    this.pitch = pitch
    this.oldYaw = yaw
    this.oldPitch = pitch
    this.onGround = true
    this.lastSendPos = performance.now()
    this.armor = []
  }
}

export class FakePlayer {
  name: string
  uuid: string
  skinLookup: boolean
  bot: Bot
  fakePlayerEntity: FakeEntity
  static fakePlayerId: number = 9999
  listenerMove: () => void = () => {}
  listenerForceMove: () => void = () => {}
  listenerPhysics: () => void = () => {}
  listenerInventory: () => void = () => {}
  listenerWorldLeave: () => void = () => {}
  listenerWorldJoin: () => void = () => {}
  pItem: typeof ItemType
  connectedClients: ServerClient[]
  private isSpawnedMap: Record<string, boolean> = {}
  private readonly positionTransformer: IPositionTransformer | undefined
  constructor (
    bot: Bot,
    options: { username?: string, uuid?: string, skinLookup?: boolean, positionTransformer?: IPositionTransformer } = {}
  ) {
    this.name = options.username ?? 'Player'
    this.uuid = options.uuid ?? 'a01e3843-e521-3998-958a-f459800e4d11'
    this.skinLookup = options.skinLookup ?? true
    this.bot = bot
    this.fakePlayerEntity = new FakeEntity(bot.entity.position.clone(), bot.entity.yaw, bot.entity.pitch)
    this.pItem = itemLoader(bot.version)
    this.initListener()
    this.connectedClients = []
    this.positionTransformer = options.positionTransformer
  }

  static gameModeToNotchian (gamemode: string): 1 | 0 | 2 {
    switch (gamemode) {
      case 'survival':
        return 0
      case 'creative':
        return 1
      case 'adventure':
        return 2
      default:
        return 0
    }
  }

  private writeRaw (client: ServerClient | Client, name: string, data: any) {
    if (this.positionTransformer != null) {
      const result = this.positionTransformer.onSToCPacket(name, data)
      if (!result) return
      if (result && result.length > 1) return
      const [transformedName, transformedData] = result[0]
      client.write(transformedName, transformedData)
    } else {
      client.write(name, data)
    }
  }

  private initListener () {
    const writeIfSpawned = (name: string, data: Object) => {
      this.connectedClients.forEach((c) => {
        if (!this.isSpawnedMap[c.uuid]) return
        this.writeRaw(c, name, data)
      })
    }
    this.listenerMove = () => {
      // From flying-squid updatePosition.js
      // known position is very important because the diff (/delta) send to players is floored hence is not precise enough
      // storing the known position allows to compensate next time a diff is sent
      // without the known position, the error accumulate fast and player position is incorrect from the point of view
      // of other players
      // const knownPosition = this.fakePlayerEntity.knownPosition
      const position = this.bot.entity.position

      const entityPosition = position // 1.12.2 Specific
      this.fakePlayerEntity.knownPosition = position
      this.fakePlayerEntity.onGround = this.bot.entity.onGround
      this.fakePlayerEntity.yaw = this.bot.entity.yaw
      this.fakePlayerEntity.pitch = this.bot.entity.pitch
      writeIfSpawned('entity_teleport', {
        entityId: FakePlayer.fakePlayerId,
        x: entityPosition.x,
        y: entityPosition.y,
        z: entityPosition.z,
        yaw: -(Math.floor(((this.bot.entity.yaw / Math.PI) * 128 + 255) % 256) - 127),
        pitch: -Math.floor(((this.bot.entity.pitch / Math.PI) * 128) % 256),
        // onGround: this.bot.entity.onGround
        onGround: false
      })
      writeIfSpawned('entity_look', {
        entityId: FakePlayer.fakePlayerId,
        yaw: -(Math.floor(((this.bot.entity.yaw / Math.PI) * 128 + 255) % 256) - 127),
        pitch: -Math.floor(((this.bot.entity.pitch / Math.PI) * 128) % 256),
        onGround: false
      })
      writeIfSpawned('entity_head_rotation', {
        entityId: FakePlayer.fakePlayerId,
        headYaw: -(Math.floor(((this.bot.entity.yaw / Math.PI) * 128 + 255) % 256) - 127)
      })
    }
    this.listenerForceMove = () => {
      this.fakePlayerEntity.knownPosition = this.bot.entity.position
      this.fakePlayerEntity.yaw = this.bot.entity.yaw
      this.fakePlayerEntity.pitch = this.bot.entity.pitch

      writeIfSpawned('entity_teleport', {
        entityId: 9999,
        x: this.bot.entity.position.x,
        y: this.bot.entity.position.y,
        z: this.bot.entity.position.z,
        yaw: this.bot.entity.yaw,
        pitch: this.bot.entity.pitch,
        onGround: this.bot.entity.onGround
      })
    }
    this.listenerInventory = () => {
      this.connectedClients.forEach((c) => {
        if (!this.isSpawnedMap[c.uuid]) return
        this.updateEquipment(c)
      })
    }
    this.listenerWorldLeave = () => {
      const timeout = setTimeout(() => {
        this.bot._client.off('position', this.listenerWorldJoin)
      }, 5000)
      this.bot._client.once('position', () => {
        clearTimeout(timeout)
        this.listenerWorldJoin()
      })
      this.connectedClients.forEach((c) => {
        if (!this.isSpawnedMap[c.uuid]) return
        this.writeDestroyEntity(c)
      })
    }
    this.listenerWorldJoin = () => {
      this.connectedClients.forEach((c) => {
        if (!this.isSpawnedMap[c.uuid]) return
        this.writePlayerEntity(c)
      })
    }
    this.bot.on('move', this.listenerMove)
    // setInterval(this.listenerMove.bind(this), 50)
    this.bot.on('forcedMove', this.listenerForceMove)
    this.bot.inventory.on('updateSlot', this.listenerInventory)
    this.bot._client.on('mcproxy:heldItemSlotUpdate', () => {
      if (this.listenerInventory) this.listenerInventory()
    })
    this.bot.on('respawn', this.listenerWorldLeave)
  }

  register (client: ServerClient) {
    if (!this.connectedClients.includes(client)) {
      this.connectedClients.push(client)
      this.spawn(client)
    }
  }

  unregister (client: ServerClient) {
    this.connectedClients = this.connectedClients.filter((c) => c !== client)
    this.deSpawn(client)
  }

  destroy () {
    this.bot.removeListener('move', this.listenerMove)
    this.bot.removeListener('forcedMove', this.listenerForceMove)
    if (this.listenerInventory) {
      this.bot.inventory.removeListener('updateSlot', this.listenerInventory)
    }
    this.bot.removeListener('respawn', this.listenerWorldLeave)
  }

  async writePlayerInfo (client: ServerClient) {
    // console.info('Sending request', `https://sessionserver.mojang.com/session/minecraft/profile/${this.uuid}?unsigned=false`)
    let properties = []
    if (this.skinLookup) {
      let response
      try {
        response = await fetch(
          `https://sessionserver.mojang.com/session/minecraft/profile/${this.uuid}?unsigned=false`
        )
        if (response.status !== 204) {
          const p = (await response.json())
          properties = p?.properties ?? []
          if (properties?.length !== 1) {
            console.warn('Skin lookup failed for', this.uuid)
          }
        } else {
          console.warn('Offline mode, no skin for', this.uuid)
        }
      } catch (err) {
        console.error('Skin lookup failed', err, response)
      }
    }
    // console.info('Player profile', p)
    this.writeRaw(client, 'player_info', {
      action: 0,
      data: [
        {
          UUID: this.uuid,
          name: this.name,
          properties,
          gamemode: FakePlayer.gameModeToNotchian(this.bot.game.gameMode),
          ping: 0
        }
      ]
    })
  }

  updateEquipment (client: ServerClient) {
    const objectEqual = (item1?: object, item2?: object) => {
      item1 = item1 ?? {}
      item2 = item2 ?? {}
      return JSON.stringify(item1) === JSON.stringify(item2)
    }

    this.bot.updateHeldItem()
    const mainHand = (this.bot.heldItem != null) ? this.pItem.toNotch(this.bot.heldItem) : NoneItemData
    const offHand = this.bot.inventory.slots[45] ? this.pItem.toNotch(this.bot.inventory.slots[45]) : NoneItemData
    // Main hand
    if (!objectEqual(mainHand, this.fakePlayerEntity.mainHand)) {
      this.writeRaw(client, 'entity_equipment', {
        entityId: FakePlayer.fakePlayerId,
        slot: 0,
        item: mainHand
      })
      this.fakePlayerEntity.mainHand = mainHand
    }
    // Off-Hand
    if (!objectEqual(offHand, this.fakePlayerEntity.offHand)) {
      this.writeRaw(client, 'entity_equipment', {
        entityId: FakePlayer.fakePlayerId,
        slot: 1,
        item: offHand
      })
      this.fakePlayerEntity.offHand = offHand
    }
    // Armor
    const equipmentMap = [5, 4, 3, 2]
    for (let i = 0; i < 4; i++) {
      // Armor slots start at 5
      const armorItem = this.bot.inventory.slots[i + 5]
        ? this.pItem.toNotch(this.bot.inventory.slots[i + 5])
        : NoneItemData
      if (objectEqual(armorItem, this.fakePlayerEntity.armor[i])) continue
      this.writeRaw(client, 'entity_equipment', {
        entityId: FakePlayer.fakePlayerId,
        slot: equipmentMap[i],
        item: armorItem
      })
      this.fakePlayerEntity.armor[i] = armorItem
    }
  }

  private writePlayerEntity (client: ServerClient) {
    this.writeRaw(client, 'named_entity_spawn', {
      entityId: FakePlayer.fakePlayerId,
      playerUUID: this.uuid,
      x: this.bot.entity.position.x,
      y: this.bot.entity.position.y,
      z: this.bot.entity.position.z,
      yaw: this.bot.entity.yaw,
      pitch: this.bot.entity.pitch,
      metadata: [
        {
          key: 5,
          type: 6,
          value: true // No gravity
        }
      ]
    })

    this.updateEquipment(client)

    this.writeRaw(client, 'entity_look', {
      entityId: FakePlayer.fakePlayerId,
      yaw: this.bot.entity.yaw,
      pitch: this.bot.entity.pitch,
      onGround: this.bot.entity.onGround
    })

    this.writeRaw(client, 'entity_head_rotation', {
      entityId: FakePlayer.fakePlayerId,
      headYaw: -(Math.floor(((this.bot.entity.yaw / Math.PI) * 128 + 255) % 256) - 127)
    })
  }

  private spawn (client: ServerClient) {
    // if (this.isSpawned) throw new Error('Already spawned')
    if (client.uuid in this.isSpawnedMap && this.isSpawnedMap[client.uuid]) console.warn('Already spawned')
    // this.initListener()
    this.writePlayerInfo(client)
      .then(() => {
        this.writePlayerEntity(client)
        this.isSpawnedMap[client.uuid] = true
      })
      .catch(console.error)
  }

  private writeDestroyEntity (client: ServerClient) {
    this.writeRaw(client, 'entity_destroy', {
      entityIds: [FakePlayer.fakePlayerId]
    })
  }

  private deSpawn (client: ServerClient) {
    // if (!this.isSpawned) throw new Error('Nothing to de-spawn player not spawned')
    if (client.uuid in this.isSpawnedMap) {
      // if (!this.isSpawnedMap[client.uuid]) console.warn('Nothing to de-spawn player not spawned')
    }
    this.writeDestroyEntity(client)
    this.writeRaw(client, 'player_info', {
      action: 4,
      data: [
        {
          UUID: this.uuid
        }
      ]
    })
    this.isSpawnedMap[client.uuid] = false
  }
}

class SpectatorInfo {
  private _status: boolean

  public get status () {
    return this._status
  }

  public set status (val: boolean) {
    this.cleanup()
    this._status = val
  }

  public readonly client: Client
  public position: Vec3 = new Vec3(0, 0, 0)
  public yaw: number = 0
  public pitch: number = 0
  public onGround: boolean = false
  public readonly cleanup: () => void
  constructor (client: Client, position: Vec3, status: boolean = false, cleanup: () => void = () => {}) {
    this.client = client
    this.cleanup = cleanup
    this.position = position
    this._status = status

    this.client.on('packet', this.posListener)
  }

  posListener = (data: any, meta: PacketMeta) => {
    if (meta.name.includes('position')) {
      this.position = new Vec3(data.x, data.y, data.z)
      this.onGround = data.onGround
    }
    if (meta.name.includes('look')) {
      this.yaw = data.yaw
      this.pitch = data.pitch
      this.onGround = data.onGround
    }
  }
}

export class FakeSpectator {
  bot: Bot
  clientsInCamera: Record<string, SpectatorInfo> = {}
  positionTransformer?: IPositionTransformer
  constructor (bot: Bot, options: { positionTransformer?: IPositionTransformer } = {}) {
    this.bot = bot
    this.positionTransformer = options.positionTransformer
  }

  private writeRaw (client: ServerClient | Client, name: string, data: any) {
    if (this.positionTransformer != null) {
      const result = this.positionTransformer.onSToCPacket(name, data)
      if (!result) return
      if (result && result.length > 1) return
      const [transformedName, transformedData] = result[0]
      client.write(transformedName, transformedData)
    } else {
      client.write(name, data)
    }
  }

  makeSpectator (client: ServerClient) {
    this.writeRaw(client, 'player_info', {
      action: 1,
      data: [
        {
          UUID: client.uuid,
          gamemode: 3
        }
      ]
    })
    this.writeRaw(client, 'game_state_change', {
      reason: 3, // https://wiki.vg/index.php?title=Protocol&oldid=14204#Change_Game_State
      gameMode: 3
    })
    this.writeRaw(client, 'abilities', {
      flags: 7,
      flyingSpeed: 0.05000000074505806,
      walkingSpeed: 0.10000000149011612
    })
  }

  revertToNormal (client: ServerClient) {
    this.writeRaw(client, 'position', {
      ...this.bot.entity.position,
      yaw: this.bot.entity.yaw,
      pitch: this.bot.entity.pitch,
      onGround: this.bot.entity.onGround
    })
    const a = packetAbilities(this.bot)
    this.writeRaw(client, a.name, a.data)
    this.writeRaw(client, 'game_state_change', {
      reason: 3, // https://wiki.vg/index.php?title=Protocol&oldid=14204#Change_Game_State
      gameMode: FakePlayer.gameModeToNotchian(this.bot.game.gameMode)
    })
  }

  tpToFakePlayer (client: Client | ServerClient) {
    this.writeRaw(client, 'position', {
      ...this.bot.entity.position
    })
  }

  tpToCoords (client: Client | ServerClient, x?: number, y?: number, z?: number) {
    console.log({
      x: x && !isNaN(x) ? x : this.clientsInCamera[client.uuid].position.x,
      y: y && !isNaN(y) ? y : this.clientsInCamera[client.uuid].position.y,
      z: z && !isNaN(z) ? z : this.clientsInCamera[client.uuid].position.z
      // yaw: this.clientsInCamera[client.uuid].yaw,
      // pitch: this.clientsInCamera[client.uuid].pitch,
      // onGround: this.clientsInCamera[client.uuid].onGround
    })
    this.writeRaw(client, 'position', {
      x: x && !isNaN(x) ? x : this.clientsInCamera[client.uuid].position.x,
      y: y && !isNaN(y) ? y : this.clientsInCamera[client.uuid].position.y,
      z: z && !isNaN(z) ? z : this.clientsInCamera[client.uuid].position.z,
      yaw: this.clientsInCamera[client.uuid].yaw,
      pitch: this.clientsInCamera[client.uuid].pitch,
      onGround: this.clientsInCamera[client.uuid].onGround
    })
  }

  register (client: Client | ServerClient, status: boolean = false, cleanup: () => void = () => {}) {
    this.clientsInCamera[client.uuid]?.cleanup()
    this.clientsInCamera[client.uuid] = new SpectatorInfo(client, this.bot.entity.position.clone(), status, cleanup)
  }

  unregister (client: Client | ServerClient) {
    this.register(client, false, () => {})
  }

  makeViewingBotPov (client: Client | ServerClient) {
    if (this.clientsInCamera[client.uuid]) {
      if (this.clientsInCamera[client.uuid].status) {
        console.warn('Already in the camera', client.username)
        return false
      }
    } else {
      this.register(client)
    }

    this.writeRaw(client, 'camera', {
      cameraId: FakePlayer.fakePlayerId
    })
    const updatePos = () => {
      this.writeRaw(client, 'position', {
        ...this.bot.entity.position,
        yaw: 180 - (this.bot.entity.yaw * 180) / Math.PI,
        pitch: -(this.bot.entity.pitch * 180) / Math.PI,
        onGround: this.bot.entity.onGround
      })
    }
    updatePos()
    const onMove = () => updatePos()
    const cleanup = () => {
      this.bot.removeListener('move', onMove)
      this.bot.removeListener('end', cleanup)
      client.removeListener('end', cleanup)
    }
    this.bot.on('move', onMove)
    this.bot.once('end', cleanup)
    client.once('end', cleanup)
    this.register(client, true, cleanup)
    return true
  }

  revertPov (client: Client | ServerClient) {
    if (!this.clientsInCamera[client.uuid]) return false
    if (!this.clientsInCamera[client.uuid].status) return false
    this.writeRaw(client, 'camera', {
      cameraId: this.bot.entity.id
    })
    this.unregister(client)
    return true
  }
}

function gamemodeToNumber (str: GameState['gameMode']) {
  if (str === 'survival') {
    return 0
  } else if (str === 'creative') {
    return 1
  } else if (str === 'adventure') {
    return 2
  } else if (str === 'spectator') {
    return 3
  }
}
