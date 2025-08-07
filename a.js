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
const SHELTER_MODE = 'shelter_mode';

const CONFIG = {
    host: '54.151.198.24',
    port: 25565,
    username: 'TheKnight',
    masterUsername: 'RAREAURA',
    attackDelay: 50,
    maxRadius: 20,
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
    if (!master || !currentTarget) {
        // No target, return to follow mode
        currentMode = FOLLOW_MODE;
        return;
    }
    
    const distance = bot.entity.position.distanceTo(currentTarget.position);
    
    // Equip best weapon
    const weapon = findBestWeapon();
    if (weapon) {
        await equipItem(weapon.name);
    }
    
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

// Auto Healing and Totem Logic
const handleHealing = async () => {
    if (bot.health < 10) {
        const gapple = findItem('golden_apple');
        if (gapple) {
            await equipItem('golden_apple');
            await bot.consume();
            console.log(`[TheKnight] Eating golden apple for regeneration.`);
        }
    }
    if (bot.health < 4) {
        const totem = findItem('totem_of_undying');
        if (totem) {
            await equipItem('totem_of_undying', 'off-hand');
            console.log(`[TheKnight] Equipping totem of undying.`);
        }
    }
};

// Water Clutch Logic
const handleSelfClutch = async () => {
    if (bot.entity.velocity.y < -0.5 && lastBotY !== null) {
        const fallHeight = lastBotY - bot.entity.position.y;
        if (fallHeight > 9) {
            currentMode = MGL_CLUTCH_MODE;
            console.log(`[TheKnight] I am falling from a height of ~${fallHeight.toFixed(0)} blocks. Initiating self-clutch.`);
            const waterBucket = findItem('water_bucket');
            if (waterBucket) {
                const groundPos = bot.entity.position.offset(0, -1, 0).floored();
                
                await equipItem('water_bucket');
                await bot.lookAt(groundPos.offset(0, 0, 0));
                
                const blockToPlaceOn = bot.blockAt(groundPos);
                
                if (blockToPlaceOn && blockToPlaceOn.type !== bot.mcData.blocksByName.air.id) {
                    await bot.placeBlock(blockToPlaceOn, new Vec3(0, 1, 0));
                    console.log(`[TheKnight] Successfully placed water bucket.`);
                }
            } else {
                console.log(`[TheKnight] I am falling, but I have no water bucket!`);
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
    console.log(`[TheKnight] Building shelter for master.`);

    const buildingBlock = findBuildingBlock();
    if (!buildingBlock) {
        bot.chat(`I have no building blocks! I am but a humble knight with empty hands.`);
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
    console.log(`[TheKnight] Shelter built. Returning to follow mode.`);
    currentMode = FOLLOW_MODE;
};

// Event handlers
bot.once('spawn', () => {
    bot.mcData = require('minecraft-data')(bot.version);
    bot.chat('TheKnight v1. [ bEta ] has arrived, ready to serve! My watch begins.');
    console.log('[TheKnight] Bot is ready! Waiting for master.');
});

bot.on('playerJoined', (player) => {
    if (player.username === CONFIG.masterUsername) {
        master = player.entity;
        currentMode = FOLLOW_MODE;
        console.log(`[TheKnight] Master ${CONFIG.masterUsername} found. Entering follow mode.`);
    }
});

// Primary bot logic loop
bot.on('physicsTick', async () => {
    if (!master) {
        return;
    }

    await handleSelfClutch();
    if (currentMode === MGL_CLUTCH_MODE) return;

    if (currentMode === SHELTER_MODE) return;

    handleHealing();

    // Prioritize attacking if a target exists
    if (currentTarget) {
        currentMode = THREAT_ATTACK_MODE;
        pvpLogic();
        return;
    }

    // If no target, check for new threats
    const potentialTargets = bot.entities.filter(e => {
        return (e.type === 'mob' || (e.type === 'player' && e.username !== CONFIG.masterUsername)) && e.position.distanceTo(master.position) < CONFIG.maxRadius;
    });

    if (potentialTargets.length > 0) {
        const closestThreat = potentialTargets.sort((a, b) => master.position.distanceTo(a.position) - master.position.distanceTo(b.position))[0];
        if (!currentTarget || closestThreat.position.distanceTo(master.position) < currentTarget.position.distanceTo(master.position)) {
            currentTarget = closestThreat;
            currentMode = THREAT_ATTACK_MODE;
            console.log(`[TheKnight] Threat detected! Engaging ${currentTarget.username || currentTarget.name}.`);
            // Check if it's a player, send a playful chat message
            if (currentTarget.type === 'player') {
                bot.chat(`/tellraw ${currentTarget.username} {"text":"Behold, knave! You've disturbed my liege, now prepare for a spanking! (This is for fun)"}`);
            }
        }
    } else {
        // No threats, return to following master
        currentMode = FOLLOW_MODE;
        currentTarget = null;
    }
    
    if (currentMode === FOLLOW_MODE) {
        bot.setControlState('sprint', true);
        const movements = new Movements(bot, bot.mcData);
        bot.pathfinder.setMovements(movements);
        bot.pathfinder.setGoal(new GoalFollow(master, 2), true);
    }
});

// Corrected entityHurt listener to handle both players and mobs
bot.on('entityHurt', (entity) => {
    if (entity.username === CONFIG.masterUsername) {
        const attacker = bot.nearestEntity((e) => {
            return (e.type === 'mob' || (e.type === 'player' && e.username !== CONFIG.masterUsername)) && e.position.distanceTo(entity.position) < 10;
        });

        if (attacker) {
            currentTarget = attacker;
            currentMode = THREAT_ATTACK_MODE;
            if (attacker.type === 'player') {
                console.log(`[TheKnight] My liege has been harmed by a player! Engaging ${attacker.username}!`);
                bot.chat(`/tellraw ${attacker.username} {"text":"Behold, knave! You've disturbed my liege, now prepare for a spanking! (This is for fun)"}`);
            } else {
                console.log(`[TheKnight] My liege has been harmed by a ${attacker.name}! Engaging!`);
            }
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
            console.log('[TheKnight] Stopping all actions by command.');
            bot.chat('As you command, my liege. I shall stand down.');
        } else if (args[0] === '!shelter') {
            createShelter();
        }
    }
});
