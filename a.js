const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { GoalNear, GoalFollow } = goals;
const { Vec3 } = require('vec3');
const { promisify } = require('util');
const sleep = promisify(setTimeout);

// Bot Modes
const FOLLOW_MODE = 'follow';
const THREAT_ATTACK_MODE = 'threat_attack';
const MGL_CLUTCH_MODE = 'mgl_clutch';
const PLAYER_ATTACK_MODE = 'player_attack';
const SHELTER_MODE = 'shelter_mode';

const CONFIG = {
    host: '54.151.198.24',
    port: 25565,
    username: 'TheKnight',
    masterUsername: 'RAREAURA', // The player to protect
    attackDelay: 50, // Fast attack for spamming
    maxRadius: 20, // Max distance bot will follow/attack from master
};

const bot = mineflayer.createBot({
    host: CONFIG.host,
    port: CONFIG.port,
    username: CONFIG.username
});

bot.loadPlugin(pathfinder);

let master = null;
let currentTarget = null;
let currentMode = null;
let lastBotY = null;

// Helper functions for hotbar and inventory management
const findBestWeapon = () => {
    const weapons = bot.inventory.items().filter(item => item.name.includes('sword') || item.name.includes('axe'));
    if (weapons.length === 0) return null;
    const priority = ['netherite_sword', 'diamond_sword', 'iron_sword', 'golden_sword', 'stone_sword', 'wooden_sword'];
    weapons.sort((a, b) => priority.indexOf(a.name) - priority.indexOf(b.name));
    return weapons[0];
};

const findBuildingBlock = () => {
    const priority = ['obsidian', 'cobblestone', 'dirt'];
    for (const name of priority) {
        const block = bot.inventory.items().find(item => item.name === name);
        if (block) return block;
    }
    return null;
};

const findItem = (itemName) => {
    return bot.inventory.items().find(item => item.name === itemName);
};

const equipItem = async (itemName, location = 'hand') => {
    const item = findItem(itemName);
    if (item && (location === 'hand' ? bot.heldItem?.name !== item.name : bot.inventory.offHand?.name !== item.name)) {
        await bot.equip(item, location);
    }
};

// Advanced PvP Logic
const pvpLogic = async () => {
    if (!master || !currentTarget) return;

    await equipItem(findBestWeapon().name);
    const distance = bot.entity.position.distanceTo(currentTarget.position);
    
    if (distance > 3) {
        const movements = new Movements(bot, bot.mcData);
        bot.pathfinder.setMovements(movements);
        bot.pathfinder.setGoal(new goals.GoalGetToBlock(currentTarget.position.x, currentTarget.position.y, currentTarget.position.z));
    } else {
        bot.pathfinder.setGoal(null);
        await bot.lookAt(currentTarget.position.offset(0, currentTarget.height, 0));
        const strafeDirection = Math.random() < 0.5 ? 'left' : 'right';
        bot.setControlState(strafeDirection, true);
        bot.setControlState('forward', true);
        bot.attack(currentTarget);
        await sleep(100); 
        bot.setControlState(strafeDirection, false);
    }
};

// Special logic for player attacks
const attackPlayerLogic = async (targetPlayer) => {
    console.log(`[PvPBot] Master is under attack! Engaging player: ${targetPlayer.username}.`);
    // Updated chat message here
    bot.chat(`/tellraw ${targetPlayer.username} {"text":"Behold, knave! You've disturbed my liege, now prepare for a spanking! (This is for fun)"}`);
    
    for (let i = 0; i < 5; i++) {
        await bot.lookAt(targetPlayer.position.offset(0, targetPlayer.height, 0));
        bot.setControlState('jump', true);
        await sleep(100);
        bot.setControlState('jump', false);
        bot.attack(targetPlayer);
        await sleep(100);
    }
    console.log(`[PvPBot] Player threat neutralized. Returning to follow mode.`);
    currentMode = FOLLOW_MODE;
    currentTarget = null;
};

// Auto Healing and Totem Logic
const handleHealing = async () => {
    if (bot.health < 10) {
        const gapple = findItem('golden_apple');
        if (gapple) {
            await equipItem('golden_apple');
            await bot.consume();
            console.log(`[PvPBot] Eating golden apple for regeneration.`);
        }
    }
    if (bot.health < 4) {
        const totem = findItem('totem_of_undying');
        if (totem) {
            await equipItem('totem_of_undying', 'off-hand');
            console.log(`[PvPBot] Equipping totem of undying.`);
        }
    }
};

// Projectile Dodging Logic
const handleProjectileDodging = async () => {
    const projectiles = bot.entities.filter(e => {
        return (e.type === 'object' || e.type === 'mob') &&
               (e.name === 'arrow' || e.name === 'fireball') &&
               e.position.distanceTo(bot.entity.position) < 15;
    });

    if (projectiles.length > 0) {
        currentMode = THREAT_ATTACK_MODE;
        const closestProjectile = projectiles.sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0];
        const awayFromProjectile = bot.entity.position.minus(closestProjectile.position).normalize();
        const dodgePosition = bot.entity.position.offset(awayFromProjectile.x * 5, 0, awayFromProjectile.z * 5);
        console.log(`[PvPBot] Dodging incoming projectile from ${closestProjectile.name}.`);
        const movements = new Movements(bot, bot.mcData);
        bot.pathfinder.setMovements(movements);
        bot.pathfinder.setGoal(new goals.GoalGetToBlock(dodgePosition.x, dodgePosition.y, dodgePosition.z));
    }
};

// Water Clutch Logic
const handleSelfClutch = async () => {
    if (bot.entity.velocity.y < -0.5 && lastBotY !== null) {
        const fallHeight = lastBotY - bot.entity.position.y;
        if (fallHeight > 9) {
            currentMode = MGL_CLUTCH_MODE;
            console.log(`[PvPBot] I am falling from a height of ~${fallHeight.toFixed(0)} blocks. Initiating self-clutch.`);
            const waterBucket = findItem('water_bucket');
            if (waterBucket) {
                const groundPos = bot.entity.position.offset(0, -1, 0).floored();
                
                await equipItem('water_bucket');
                await bot.lookAt(groundPos.offset(0, 0, 0));
                
                const blockToPlaceOn = bot.blockAt(groundPos);
                
                if (blockToPlaceOn && blockToPlaceOn.type !== bot.mcData.blocksByName.air.id) {
                    await bot.placeBlock(blockToPlaceOn, new Vec3(0, 1, 0));
                    console.log(`[PvPBot] Successfully placed water bucket.`);
                }
            } else {
                console.log(`[PvPBot] I am falling, but I have no water bucket!`);
            }
            if (currentTarget) {
                currentMode = THREAT_ATTACK_MODE;
            } else {
                currentMode = FOLLOW_MODE;
            }
        }
    }
    lastBotY = bot.entity.position.y;
};

// New shelter creation function
const createShelter = async () => {
    if (!master) return;
    currentMode = SHELTER_MODE;
    console.log(`[PvPBot] Building shelter for master.`);

    const buildingBlock = findBuildingBlock();
    if (!buildingBlock) {
        console.log(`[PvPBot] I have no building blocks! I am but a humble knight with empty hands.`);
        currentMode = FOLLOW_MODE;
        return;
    }

    const masterPos = master.position.floored();
    const positions = [
        masterPos.offset(1, 0, 0),
        masterPos.offset(-1, 0, 0),
        masterPos.offset(0, 0, 1),
        masterPos.offset(0, 0, -1)
    ];

    await equipItem(buildingBlock.name);

    for (const pos of positions) {
        const block = bot.blockAt(pos);
        if (block?.name === 'air') {
            await bot.lookAt(pos);
            await bot.placeBlock(block, new Vec3(0, 1, 0));
        }
    }

    bot.chat(`By my honor, the walls are built! My liege is safe.`);
    console.log(`[PvPBot] Shelter built. Returning to follow mode.`);
    currentMode = FOLLOW_MODE;
};

// Event handlers
bot.once('spawn', () => {
    bot.mcData = require('minecraft-data')(bot.version);
    bot.chat('TheKnight v1. [ bEta ] has arrived, ready to serve! My watch begins.');
    console.log('[PvPBot] Bot is ready! Waiting for master.');
});

bot.on('playerJoined', (player) => {
    if (player.username === CONFIG.masterUsername) {
        master = player.entity;
        currentMode = FOLLOW_MODE;
        console.log(`[PvPBot] Master ${CONFIG.masterUsername} found. Entering follow mode.`);
    }
});

bot.on('physicsTick', async () => {
    if (!master || currentMode === SHELTER_MODE) {
        return; 
    }

    await handleSelfClutch();
    if (currentMode === MGL_CLUTCH_MODE) return;

    handleHealing();
    handleProjectileDodging();

    if (currentMode === PLAYER_ATTACK_MODE || currentMode === THREAT_ATTACK_MODE) {
        pvpLogic();
        return;
    }

    if (currentMode === FOLLOW_MODE) {
        bot.setControlState('sprint', true);
        const movements = new Movements(bot, bot.mcData);
        bot.pathfinder.setMovements(movements);
        bot.pathfinder.setGoal(new GoalFollow(master, 2), true);

        const potentialTargets = bot.entities.filter(e => {
            return e.type === 'mob' && e.name !== 'unknown' && e.position.distanceTo(master.position) < CONFIG.maxRadius;
        });
        if (potentialTargets.length > 0) {
            currentTarget = potentialTargets.sort((a, b) => master.position.distanceTo(a.position) - master.position.distanceTo(b.position))[0];
            currentMode = THREAT_ATTACK_MODE;
            console.log(`[PvPBot] Hostile mob detected. Engaging ${currentTarget.name}.`);
        }
    }
});

bot.on('entityHurt', (entity) => {
    if (entity.username === CONFIG.masterUsername) {
        const attacker = bot.nearestEntity((e) => e.type === 'player' && e.position.distanceTo(entity.position) < 10);
        if (attacker) {
            currentTarget = attacker;
            currentMode = PLAYER_ATTACK_MODE;
            attackPlayerLogic(attacker);
        }
    }
});

bot.on('chat', (username, message) => {
    if (username === bot.username) return;

    if (username === CONFIG.masterUsername) {
        const args = message.split(' ');
        if (args[0] === '!stop') {
            bot.pathfinder.setGoal(null);
            currentMode = FOLLOW_MODE;
            console.log('[PvPBot] Stopping all actions by command.');
            bot.chat('As you command, my liege. I shall stand down.');
        } else if (args[0] === '!shelter') {
            createShelter();
        }
    }
});
