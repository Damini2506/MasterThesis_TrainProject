/**
 * @file etcs_states.js
 * @brief Defines the full state machine for the ETCS protocol, including states, allowed messages,
 *        valid transitions, and optional onEnter/onExit actions.
 */

// ETCS Protocol State Machine Definition
export const ETCS_STATES = {
  DISCONNECTED: {
    id: 0,
    name: "DISCONNECTED",
    validMessages: []
  },
  READY: {
    id: 1,
    name: "READY",
    validMessages: ['AU1']
  },
  HANDSHAKE_INITIATED: {
    id: 2,
    name: "HANDSHAKE_INITIATED",
    validMessages: [32, 155] // System Version
  },
  VERSION_EXCHANGED: {
    id: 3,
    name: "VERSION_EXCHANGED",
    validMessages: [32, 38, 146, 155, 159]
  },
  SESSION_ESTABLISHED: {
    id: 4,
    name: "SESSION_ESTABLISHED",
    validMessages: [8, 38, 129, 146, 155, 159, 157]
  },
  TRAIN_DATA_EXCHANGED: {
    id: 5,
    name: "TRAIN_DATA_EXCHANGED",
    validMessages: [3, 41, 157, 146, 40]
  },
  MA_REQUEST_READY: {
    id: 6,
    name: "MA_REQUEST_READY",
    validMessages: [132,146,129,3]
  },
  MISSION_ACTIVE: {
    id: 7,
    name: "MISSION_ACTIVE",
    validMessages: [15, 16, 42, 132,136]
  },
  MISSION_MONITORING: {
    id: 8,
    name: "MISSION_MONITORING",
    validMessages: [136, 146, 150, 156]
  },
  SESSION_TERMINATED: {
    id: 9,
    name: "SESSION_TERMINATED",
    validMessages: [150, 156, 39]
  }

};

export const STATE_TRANSITIONS = {
  // DISCONNECTED (0)
  0: {
    'CONNECTED': 1,
    'RESET': 0
  },
  // READY (1)
  1: {
    'AU1_SENT': 2,
    'DISCONNECT': 0
  },
  // HANDSHAKE_INITIATED (2)
  2: {
    'AU2_RECEIVED': 3,
    'M32_SENT': 3,
    'TIMEOUT': 0
  },
  // VERSION_EXCHANGED (3)
  3: {
    'M32_ACKED': 4,
    'M38_SENT': 3,
    'VERSION_MISMATCH': 0
  },
  // SESSION_ESTABLISHED (4)
  4: {
    'M8_RECEIVED': 5,
    'SESSION_TERMINATED': 0,
    'M38_SENT': 4,
    'M8_ACKED': 5,
    'M38_RECEIVED': 4,
    'M41_SENT': 6
  },
  // TRAIN_DATA_EXCHANGED (5)
  5: {
    'M3_RECEIVED': 7,  // direct to MISSION_ACTIVE
    'M41_ACKED': 6,    // ✅ transition to MA_REQUEST_READY
    'TRAIN_REJECTED': 0,
    'M8_RECEIVED': 5,
    'M8_ACKED': 5,
    'M41_RECEIVED': 5
  },
  // MA_REQUEST_READY (6)
  6: {
    'M3_SENT': 7, // ✅ once MA is sent, go to MISSION_ACTIVE
    'M3_RECEIVED': 7
  },
  // MISSION_ACTIVE (7)
  7: {
    'MONITORING_STARTED': 8, 
    'MA_EXPIRED': 0,
    'EMERGENCY_STOP': 0
  },
  // MISSION_MONITORING (8)
  8: {
    'POSITION_UPDATE': 8,       // Stay in monitoring while receiving 136s
    'MISSION_COMPLETE': 9       // You can define this when route ends
  },
  // SESSION_TERMINATED (9)
  9: {
    'RESET': 0  // Optional: allow restarting session
  }
};

export const STATE_ACTIONS = {
  0: {
    onEnter: () => console.log("Entering disconnected state"),
    onExit: () => console.log("Exiting disconnected state")
  },
  1: {
    onEnter: () => console.log("System ready for handshake"),
    onExit: () => console.log("Leaving ready state")
  },
  2: {
    onEnter: () => console.log("Starting handshake..."),
    onExit: () => console.log("Handshake completed")
  },
  3: {
    onEnter: () => console.log("Version exchanged"),
    onExit: () => console.log("Leaving version state")
  },
  4: {
    onEnter: () => console.log("Session established"),
    onExit: () => console.log("Session terminated")
  },
  5: {
    onEnter: () => console.log("Train data exchanged"),
    onExit: () => console.log("Leaving train data state")
  },
  6: {
    onEnter: () => console.log("Waiting for MA request (132)..."),
    onExit: () => console.log("MA sent, transitioning to MISSION_ACTIVE")
  },
  7: {
    onEnter: () => console.log("Mission active"),
    onExit: () => console.log("Mission ended")
  },
  8: {
  onEnter: () => console.log("Now in Mission Monitoring state"),
  onExit: () => console.log("Exiting Mission Monitoring state")
},
  9: {
    onEnter: () => console.log("✅ Session terminated."),
    onExit: () => console.log("🔄 Restarting from terminated state")
  }

};
