/**
 * @file state_manager.js
 * @brief Provides the StateManager class, responsible for handling ETCS protocol state transitions,
 *        validation, and tracking state history.
 *
 * This class uses definitions from `etcs_states.js` to manage valid state transitions, validate incoming
 * messages against current state, and execute optional `onEnter`/`onExit` actions.
 */


import { ETCS_STATES, STATE_TRANSITIONS, STATE_ACTIONS } from './etcs_states.js';

export class StateManager {
  constructor() {
    this.currentState = ETCS_STATES.DISCONNECTED.id;
    this.history = [];
    this.validateStateMachine();
    console.log(`StateManager initialized. Current state: ${this.getCurrentState().name}`);
  }

  validateStateMachine() {
    // Validate all states have corresponding transitions
    Object.values(ETCS_STATES).forEach(state => {
      if (!STATE_TRANSITIONS[state.id]) {
        console.error(`Missing transitions for state ${state.name} (ID: ${state.id})`);
      }
    });

    // Validate all transitions point to valid states
    Object.entries(STATE_TRANSITIONS).forEach(([fromStateId, transitions]) => {
      Object.values(transitions).forEach(toStateId => {
        if (!Object.values(ETCS_STATES).some(s => s.id === toStateId)) {
          console.error(`Invalid transition from ${fromStateId} to ${toStateId}`);
        }
      });
    });
  }

  transition(event) {
    
    if (!STATE_TRANSITIONS[this.currentState]?.[event]) {
      console.error(`Invalid transition from ${this.getCurrentState().name} via ${event}`);
      return false;
    }

    console.debug(`Attempting transition from ${this.currentState} via ${event}`);

    // Get current state object
    const currentStateObj = this.getCurrentState();
    if (!currentStateObj) {
      throw new Error(`Invalid current state ID: ${this.currentState}`);
    }

    // Get available transitions for current state
    const stateTransitions = STATE_TRANSITIONS[this.currentState];
    if (!stateTransitions) {
      console.error(`No transitions defined for state ${currentStateObj.name}`);
      return false;
    }

    // Get target state ID
    const newStateId = stateTransitions[event];
    if (newStateId === undefined) {
      console.warn(`Invalid transition: ${currentStateObj.name} → ${event}`);
      return false;
    }

    // Get target state object
    const newStateObj = Object.values(ETCS_STATES).find(s => s.id === newStateId);
    if (!newStateObj) {
      throw new Error(`Invalid target state ID: ${newStateId}`);
    }

    // Execute exit action for current state
    if (STATE_ACTIONS[this.currentState]?.onExit) {
      console.debug(`Executing exit action for ${currentStateObj.name}`);
      STATE_ACTIONS[this.currentState].onExit();
    }

    // Record transition
    this.history.push({
      from: currentStateObj.name,
      to: newStateObj.name,
      event,
      timestamp: Date.now()
    });

    // Update current state
    const previousState = this.currentState;
    this.currentState = newStateId;
    console.log(`Transitioned: ${currentStateObj.name} → ${newStateObj.name} via ${event}`);

    // Execute enter action for new state
    if (STATE_ACTIONS[this.currentState]?.onEnter) {
      console.debug(`Executing enter action for ${newStateObj.name}`);
      STATE_ACTIONS[this.currentState].onEnter();
    }

    return true;
  }

  validateMessage(msgType) {
    const currentState = this.getCurrentState();
    if (!currentState) return false;
    
    const isValid = currentState.validMessages.includes(msgType);
    console.debug(`Validating message ${msgType} in ${currentState.name}: ${isValid}`);
    return isValid;
  }

  getCurrentState() {
    const state = Object.values(ETCS_STATES).find(s => s.id === this.currentState);
    if (!state) {
      console.error(`Invalid current state ID: ${this.currentState}`);
    }
    return state;
  }

  reset() {
    const previousState = this.currentState;
    this.currentState = ETCS_STATES.DISCONNECTED.id;
    this.history = [];
    
    console.log(`Reset from ${previousState} to DISCONNECTED`);
    
    // Execute enter action for DISCONNECTED state
    if (STATE_ACTIONS[this.currentState]?.onEnter) {
      STATE_ACTIONS[this.currentState].onEnter();
    }
  }

  // Optional: Get transition history
  getHistory() {
    return [...this.history];
  }

  // Optional: Check if transition is possible
  canTransition(event) {
    const transitions = STATE_TRANSITIONS[this.currentState];
    return transitions ? transitions[event] !== undefined : false;
  }
}