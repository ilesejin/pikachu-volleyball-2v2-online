/** Playback-only chat for original 1v1 replay files. No network or recording side effects. */
let chatEnabled = true;

let getSpeechBubbleNeeded = null; // it is assigned a function after the game assets are loaded

let player1ChatRng = null;
let player2ChatRng = null;

const canvasContainer = document.getElementById('game-canvas-container');
let player1ChatBox = document.getElementById('player1-chat-box');
let player2ChatBox = document.getElementById('player2-chat-box');

/**
 * Set getSpeechBubbleNeeded function
 * @param {import('./pikavolley_replay.js').PikachuVolleyballReplay} pikaVolley
 */
export function setGetSpeechBubbleNeeded(pikaVolley) {
  getSpeechBubbleNeeded = () => {
    if (document.querySelectorAll('.fade-in-box:not(.hidden)').length > 0) {
      return true;
    }
    if (
      pikaVolley.state === pikaVolley.intro ||
      pikaVolley.state === pikaVolley.menu
    ) {
      return true;
    }
    return false;
  };
}

export function setChatRngs(rngForPlayer1Chat, rngForPlayer2Chat) {
  player1ChatRng = rngForPlayer1Chat;
  player2ChatRng = rngForPlayer2Chat;
}

export function enableChat(turnOn) {
  chatEnabled = turnOn;
}

export function hideChat() {
  player1ChatBox.classList.add('hidden');
  player2ChatBox.classList.add('hidden');
}

export function displayChatMessageAt(message, whichPlayerSide) {
  if (!chatEnabled) {
    return;
  }

  if (whichPlayerSide === 1) {
    const newChatBox = player1ChatBox.cloneNode();
    newChatBox.textContent = message;
    // @ts-ignore
    newChatBox.style.top = `${20 + 30 * player1ChatRng()}%`;
    // @ts-ignore
    newChatBox.style.right = `${55 + 25 * player1ChatRng()}%`;
    // @ts-ignore
    newChatBox.classList.remove('hidden');
    if (getSpeechBubbleNeeded && !getSpeechBubbleNeeded()) {
      // If speech Bubble is not needed
      // @ts-ignore
      newChatBox.classList.remove('in-speech-bubble');
    } else {
      // if speech bubble is not needed
      // @ts-ignore
      newChatBox.classList.add('in-speech-bubble');
    }
    canvasContainer.replaceChild(newChatBox, player1ChatBox);
    // @ts-ignore
    player1ChatBox = newChatBox;
  } else if (whichPlayerSide === 2) {
    const newChatBox = player2ChatBox.cloneNode();
    newChatBox.textContent = message;
    // @ts-ignore
    newChatBox.style.top = `${20 + 30 * player2ChatRng()}%`;
    // @ts-ignore
    newChatBox.style.left = `${55 + 25 * player2ChatRng()}%`;
    // @ts-ignore
    newChatBox.classList.remove('hidden');
    if (getSpeechBubbleNeeded && !getSpeechBubbleNeeded()) {
      // If speech Bubble is not needed
      // @ts-ignore
      newChatBox.classList.remove('in-speech-bubble');
    } else {
      // if speech bubble is not needed
      // @ts-ignore
      newChatBox.classList.add('in-speech-bubble');
    }
    canvasContainer.replaceChild(newChatBox, player2ChatBox);
    // @ts-ignore
    player2ChatBox = newChatBox;
  }
}
