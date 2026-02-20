/**
 * @file dynamic_ui.js
 * @brief Contains UI-related logic for rendering ETCS track topology, Packet 15 visualization,
 *        and dynamic MA generation based on topology and sensor layout. Support file for DynamicRBC
 */

let routeData = {};
let topology = {};

/**
 * @brief Initializes route and topology data from global window scope.
 */
export function initUI() {
  if (!window.routeData) {
    console.warn("Route data not initialized.");
    return;
  }
  routeData = window.routeData;
  topology = window.topology;
}

/**
 * @brief Returns all available route IDs defined in the topology.
 * @return {string[]} List of route identifiers.
 */
export function getAvailableRouteIds() {
  return Object.keys(routeData);
}

/**
 * @brief Generates Packet 15 structure for a given route.
 * @param {Array} trackList - Ordered list of track segment IDs.
 * @param {string} routeId - Route identifier (e.g., ST1_ST2).
 * @param {any} fromCurrentPosition - Optional current position (not used).
 * @param {Object} topology - Full topology object containing tracks, stations, sensors.
 * @return {Object|null} Packet 15 data structure.
 */
export function generatePacket15ForRoute(trackList, routeId, fromCurrentPosition = null, topology) {
  // Validate inputs
  if (!trackList || !trackList.length || !routeId || !topology) {
    console.error("Invalid parameters for Packet15 generation");
    return null;
  }

  const { tracks, stations, sensors } = topology;
  if (!tracks || !stations || !sensors) {
    console.error("Incomplete topology data");
    return null;
  }

  // Initialize Packet15 with default values
  const packet = {
    NID_PACKET: 15,
    Q_DIR: 1, // Default direction
    L_PACKET: 0,
    Q_SCALE: 1,
    V_EMA: 0,
    T_EMA: 1023,
    N_ITER: 0,
    sections: [],
    L_ENDSECTION: 0,
    Q_SECTIONTIMER: 0,
    T_SECTIONTIMER: 0,
    D_SECTIONTIMERSTOPLOC: 0,
    Q_ENDTIMER: 0,
    T_ENDTIMER: 0,
    D_ENDTIMERSTARTLOC: 0,
    Q_DANGERPOINT: 0,
    D_DP: 0,
    V_RELEASEDP: 0,
    Q_OVERLAP: 0,
    D_STARTOL: 0,
    T_OL: 0,
    D_OL: 0,
    V_RELEASEOL: 0
  };

  // Helper function to calculate track length
  const calculateTrackLength = (trackId) => {
    const track = tracks[trackId];
    if (!track) return 0;
    const dx = track.x2 - track.x1;
    const dy = track.y2 - track.y1;
    return Math.sqrt(dx * dx + dy * dy);
  };

  // Get ordered sensors along the route
  const getRouteSensors = () => {
    const sensorSequence = [];
    let currentNode = trackList[0].from; // Start from first track's from node
    
    for (const trackId of trackList) {
      const track = tracks[trackId];
      if (!track) continue;
      
      // Determine next node
      const nextNode = track.from === currentNode ? track.to : track.from;
      
      // If current or next node is a sensor, add to sequence
      if (sensors[currentNode] && !sensorSequence.includes(currentNode)) {
        sensorSequence.push(currentNode);
      }
      if (sensors[nextNode] && !sensorSequence.includes(nextNode)) {
        sensorSequence.push(nextNode);
      }
      
      currentNode = nextNode;
    }
    
    return sensorSequence;
  };

  const routeSensors = getRouteSensors();
  const [fromStation, toStation] = routeId.split('_');

  // Determine direction (1=nominal, 0=reverse)
  const firstTrack = tracks[trackList[0]];
  packet.Q_DIR = firstTrack.from === fromStation ? 1 : 0;

  // Generate sections between sensors
  for (let i = 0; i < routeSensors.length - 1; i++) {
    let sectionLength = 0;
    let inSection = false;

    for (const trackId of trackList) {
      const track = tracks[trackId];
      if (!track) continue;

      // Check if we've entered the section
      if (track.from === routeSensors[i] || track.to === routeSensors[i]) {
        inSection = true;
      }

      // Add length if in section
      if (inSection) {
        sectionLength += calculateTrackLength(trackId);
      }

      // Check if we've reached the next sensor
      if (track.from === routeSensors[i+1] || track.to === routeSensors[i+1]) {
        break;
      }
    }

    if (sectionLength > 0) {
      packet.sections.push({
        L_SECTION: Math.round(sectionLength),
        Q_SECTIONTIMER: 0,
        T_SECTIONTIMER: 0,
        D_SECTIONTIMERSTOPLOC: 0
      });
    }
  }

  packet.N_ITER = packet.sections.length;

  // Calculate end section (from last sensor to destination)
  let endSectionLength = 0;
  let reachedLastSensor = false;

  for (const trackId of trackList) {
    const track = tracks[trackId];
    if (!track) continue;

    if (track.from === routeSensors[routeSensors.length-1] || 
        track.to === routeSensors[routeSensors.length-1]) {
      reachedLastSensor = true;
    }

    if (reachedLastSensor) {
      endSectionLength += calculateTrackLength(trackId);
      
      // Stop when we reach destination station
      if (track.from === toStation || track.to === toStation) {
        break;
      }
    }
  }

  packet.L_ENDSECTION = Math.round(endSectionLength);

  // Calculate total packet length (in bits)
  packet.L_PACKET = 93 + (packet.N_ITER * 46);

  return packet;
}

/**
 * @brief Highlights route tracks on screen.
 * @param {string} routeId - Route identifier to highlight.
 */
export function highlightRoute(routeId) {
  const route = routeData[routeId];
  if (!route) return;

  document.querySelectorAll('.track').forEach(el => el.classList.remove('active'));

  route.tracks.forEach(trackId => {
    const el = document.getElementById(trackId);
    if (el) el.classList.add('active');
  });
}

/**
 * @brief Displays the contents of Packet 15 on the UI panel.
 * @param {Object} packet - Packet 15 data object.
 */
export function displayPacket15(packet) {
  const display = document.getElementById("maDisplay");
  const content = document.getElementById("maContent");

  if (!packet || !display || !content) return;

  display.style.display = "block";

  let html = '<div class="ma-section">';
  html += `<span class="ma-field">NID_PACKET:</span> ${packet.NID_PACKET}<br>`;
  html += `<span class="ma-field">Q_DIR:</span> ${packet.Q_DIR}<br>`;
  html += `<span class="ma-field">L_PACKET:</span> ${packet.L_PACKET} bits<br>`;
  html += `<span class="ma-field">Q_SCALE:</span> ${packet.Q_SCALE} (1 meter)<br>`;
  html += `<span class="ma-field">V_EMA:</span> ${packet.V_EMA} km/h (Emergency stop if passed)<br>`;
  html += `<span class="ma-field">T_EMA:</span> ${packet.T_EMA} (No timer - infinite)<br>`;
  html += `<span class="ma-field">N_ITER:</span> ${packet.N_ITER} sections<br>`;
  html += '</div>';

  if (packet.N_ITER > 0) {
    html += '<div class="ma-section" style="background-color: #2a1a1a;">';
    html += '<strong>Track Sections:</strong><br>';
    html += '</div>';
    
    packet.sections.forEach((section, idx) => {
      html += '<div class="ma-section">';
      html += `<strong>Section ${idx + 1}:</strong><br>`;
      html += `<span class="ma-field">L_SECTION:</span> ${section.L_SECTION} meters<br>`;
      html += `<span class="ma-field">Q_SECTIONTIMER:</span> ${section.Q_SECTIONTIMER} (No timer)<br>`;
      html += '</div>';
    });
  }

  html += '<div class="ma-section" style="background-color: #1a2a1a;">';
  html += '<strong>End Section:</strong><br>';
  html += `<span class="ma-field">L_ENDSECTION:</span> ${packet.L_ENDSECTION} meters<br>`;
  html += `<span class="ma-field">Q_SECTIONTIMER:</span> ${packet.Q_SECTIONTIMER} (No timer)<br>`;
  html += '</div>';

  content.innerHTML = html;
}

/**
 * @brief Renders SVG representation of topology (tracks, sensors, stations).
 * @param {Object} topology - Topology data with visual coordinates.
 */
export function renderSvgFromTopology(topology) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 1000 500");
  svg.setAttribute("width", "100%");
  svg.setAttribute("height", "100%");
  svg.innerHTML = "";

  // Add pattern for occupied tracks
  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  const pattern = document.createElementNS("http://www.w3.org/2000/svg", "pattern");
  pattern.setAttribute("id", "redYellowStripes");
  pattern.setAttribute("patternUnits", "userSpaceOnUse");
  pattern.setAttribute("width", "8");
  pattern.setAttribute("height", "8");
  pattern.setAttribute("patternTransform", "rotate(45)");
  
  const rect1 = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  rect1.setAttribute("width", "4");
  rect1.setAttribute("height", "8");
  rect1.setAttribute("fill", "red");
  
  const rect2 = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  rect2.setAttribute("x", "4");
  rect2.setAttribute("width", "4");
  rect2.setAttribute("height", "8");
  rect2.setAttribute("fill", "yellow");
  
  pattern.appendChild(rect1);
  pattern.appendChild(rect2);
  defs.appendChild(pattern);
  svg.appendChild(defs);

  // Draw tracks
  Object.values(topology.tracks).forEach(t => {
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", t.x1);
    line.setAttribute("y1", t.y1);
    line.setAttribute("x2", t.x2);
    line.setAttribute("y2", t.y2);
    line.setAttribute("id", t.id);
    line.setAttribute("stroke", "lime");
    line.setAttribute("stroke-width", "3");
    line.classList.add("track");
    svg.appendChild(line);
  });

  // Draw sensors
  Object.values(topology.sensors).forEach(s => {
    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("cx", s.x);
    circle.setAttribute("cy", s.y);
    circle.setAttribute("r", "6");
    circle.setAttribute("fill", "white");
    circle.setAttribute("class", "sensor");
    svg.appendChild(circle);

    // Add sensor label
    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.setAttribute("x", s.x - 5);
    text.setAttribute("y", s.y - 10);
    text.setAttribute("fill", "yellow");
    text.setAttribute("font-size", "10px");
    text.setAttribute("font-weight", "bold");
    text.textContent = s.id;
    svg.appendChild(text);
  });

  // Draw stations
  Object.values(topology.stations).forEach(st => {
    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.setAttribute("x", st.x);
    text.setAttribute("y", st.y - 15);
    text.setAttribute("fill", "cyan");
    text.setAttribute("font-size", "14px");
    text.setAttribute("font-weight", "bold");
    text.textContent = st.name;
    svg.appendChild(text);

    // Add station type if available
    if (st.type && st.type !== 'unknown') {
      const typeText = document.createElementNS("http://www.w3.org/2000/svg", "text");
      typeText.setAttribute("x", st.x);
      typeText.setAttribute("y", st.y - 3);
      typeText.setAttribute("fill", "#aaa");
      typeText.setAttribute("font-size", "11px");
      typeText.textContent = `(${st.type})`;
      svg.appendChild(typeText);
    }
  });

  const container = document.getElementById("svgContainer");
  container.innerHTML = "";
  container.appendChild(svg);
}

/**
 * @brief Updates track/switch occupancy options in the dropdown.
 * @param {Object} topology - Topology data with switches and tracks.
 */
export function updateOccupancyControls(topology) {
  const select = document.getElementById('occupancySelect');
  if (!select) return;
  select.innerHTML = '<option value="">-- Occupancy Control --</option>';

  const switchGroups = {};
  
  // Add switch controls
  Object.values(topology.switches || {}).forEach(sw => {
    const trackIds = sw.tracks || [];
    switchGroups[sw.id] = trackIds;
    
    select.innerHTML += `<option value="occupy_${sw.id}">Occupy Switch ${sw.id}</option>`;
    select.innerHTML += `<option value="free_${sw.id}">Free Switch ${sw.id}</option>`;
  });

  // Add regular tracks
  Object.keys(topology.tracks).forEach(trackId => {
    // Skip if part of a switch
    let isPartOfSwitch = false;
    Object.values(switchGroups).forEach(trackList => {
      if (trackList.includes(trackId)) isPartOfSwitch = true;
    });
    
    if (!isPartOfSwitch) {
      select.innerHTML += `<option value="occupy_${trackId}">Occupy ${trackId}</option>`;
      select.innerHTML += `<option value="free_${trackId}">Free ${trackId}</option>`;
    }
  });

  select.innerHTML += '<option value="free_all">Free all</option>';
}

/**
 * @brief Highlights the specific track section based on train position.
 * @param {Array} trackList - Ordered list of track IDs in the route.
 * @param {number} trainPosition - Current position (distance in meters).
 * @param {Object} topology - Topology data.
 */
export function highlightTrainSection(trackList, trainPosition, topology) {
  if (!trackList || !trainPosition || !topology?.tracks) return;

  // Reset old red highlights
  document.querySelectorAll('.track').forEach(el => el.classList.remove('occupied'));


  let cumulative = 0;
  for (let i = 0; i < trackList.length; i++) {
    const trackId = trackList[i];
    const track = topology.tracks[trackId];
    if (!track) continue;

    const dx = track.x2 - track.x1;
    const dy = track.y2 - track.y1;
    const len = Math.sqrt(dx * dx + dy * dy);
    cumulative += len;

    if (trainPosition <= cumulative) {
      // Highlight this track
      const el = document.getElementById(trackId);
      if (el) el.classList.add('occupied');
      break;
    }

    console.log(`Highlighting track ${trackId} at distance ${cumulative}`);

  }
}
