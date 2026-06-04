/**
 * Fritz!Box Mesh Topology Card  –  v2.2.0
 *
 * A custom Lovelace card that visualises the Fritz!Box mesh network as a
 * hierarchical tree diagram.  Data is read directly from the standard
 * fritz integration entities (no custom fritzmesh component needed):
 *
 *   • sensor.*_mesh_connected_devices  – one per mesh node (master, slaves, and switches);
 *     carries node_name, node_type, is_master, fritz_unique_id, fritz_host, node_uid,
 *     rx_rate_kbps, tx_rate_kbps in its attributes.
 *   • device_tracker.*                 – one per client device; carries
 *     connected_to, connection_type, ip, mac, cur_rx_kbps, cur_tx_kbps.
 *     Slave repeaters that appear in the hosts list also get a tracker with
 *     connection_type reflecting their uplink.
 *
 * Card YAML configuration:
 *   type: custom:fritzmesh-card
 *   entity: sensor.fritz_box_mesh_connected_devices   # required – master node sensor
 *   title: Fritz!Box Mesh               # optional; omit to use default title,
 *                                       # set to "" to hide the header entirely
 *   hide_offline_nodes: true            # optional; hide disconnected clients
 *
 * Data flow:
 *   Home Assistant state machine
 *     → set hass()          (called on every HA state update)
 *       → _render()         (only if relevant entity attributes changed)
 *         → _masterPanel()  (left sticky panel: router icon + device info)
 *         → _masterSection() (direct clients of the master)
 *         → _slaveSection()  (one section per repeater + its clients)
 *         → _switchSection() (one section per LAN switch + its clients)
 *         → _clientRow()     (individual device rows with speed/band label)
 */

const CARD_VERSION = "4.0.0";

console.info("[fritzmesh-card] script executing, version", CARD_VERSION,
  "| already defined:", !!customElements.get("fritzmesh-card"));

// ── Inline SVG icons ──────────────────────────────────────────────────────────

const ICON = {
  unknown: `<svg viewBox="0 0 24 24" fill="currentColor">
    <path d="M11 18h2v-2h-2v2zm1-16C6.48 2 2 6.48 2 12s4.48 10 10
    10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8
    8-8 8 3.59 8 8-3.59 8-8 8zm0-14c-2.21 0-4 1.79-4 4h2c0-1.1.9-2
    2-2s2 .9 2 2c0 2-3 1.75-3 5h2c0-2.25 3-2.5 3-5 0-2.21-1.79-4-4-4z"/>
  </svg>`,

  transfer: `<svg viewBox="0 0 24 24" fill="currentColor">
    <path d="M7 6h10l-3.5-3.5 1.4-1.4L21.8 8l-6.9 6.9-1.4-1.4L17 10H7V6zm10
    8H7l3.5 3.5-1.4 1.4L2.2 12l6.9-6.9 1.4 1.4L7 10h10v4z"/>
  </svg>`,

};

// ── Utility helpers ───────────────────────────────────────────────────────────

const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const HEX_COLOR_RE = /^#([0-9a-fA-F]{6})$/;

function sanitizeHexColor(value, fallback) {
  const v = String(value ?? "").trim();
  return HEX_COLOR_RE.test(v) ? v : fallback;
}

function hexToRgba(hex, alpha) {
  const clean = sanitizeHexColor(hex, "#000000").slice(1);
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function sanitizeFontScale(value, fallback = 100) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(80, Math.min(140, Math.round(n)));
}

/**
 * Format a speed value from kbit/s to a human-readable string.
 *
 * @param {number|null|undefined} kbps - Speed in kbit/s.
 * @returns {string|null} Formatted string, or null if the value is falsy/zero.
 */
function fmtSpeed(kbps) {
  if (!kbps || kbps <= 0) return null;
  if (kbps >= 1_000_000) return `${(kbps / 1_000_000).toFixed(1)} Gbit/s`;
  if (kbps >= 1_000)     return `${Math.round(kbps / 1_000)} Mbit/s`;
  return `${kbps} kbit/s`;
}

/**
 * Build the connection label shown next to each client row.
 *
 * @param {Object} c - Client object built from device_tracker attributes.
 * @param {string} c.connection_type - "WLAN" or "LAN".
 * @param {number} c.cur_rx_kbps    - Current receive speed in kbit/s.
 * @returns {string} Connection label suitable for display.
 */
function connLabel(c) {
  if (c.connection_type === "WLAN") {
    const band = c.wifi_band || "WiFi";
    const spd = fmtSpeed(c.cur_rx_kbps);
    return spd ? `${band} → ${spd}` : band;
  }
  const spd = fmtSpeed(c.cur_rx_kbps);
  return spd ? `LAN → ${spd}` : "LAN";
}

/**
 * Comparator for sorting client device arrays.
 * Connected devices sort before disconnected, then alphabetically by name.
 */
const clientSort = (a, b) => {
  if (a.connection_state !== b.connection_state)
    return a.connection_state === "CONNECTED" ? -1 : 1;
  return (a.name || a.mac || "").localeCompare(b.name || b.mac || "");
};

// ── Card component ─────────────────────────────────────────────────────────────

class FritzMeshCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config  = null;
    this._hass    = null;
    this._lastKey = "";
    this._sizeMode = "";
    this._resizeObserver = null;
    // Track rendered node/client counts for getCardSize().
    this._nodeCount   = 1;
    this._clientCount = 0;
  }

  static getStubConfig() {
    return { entity: "sensor.fritz_box_mesh_connected_devices" };
  }

  static getConfigElement() {
    return document.createElement("fritzmesh-card-editor");
  }

  connectedCallback() {
    if (!this.shadowRoot.innerHTML) {
      this.shadowRoot.innerHTML = `<style>${STYLES}</style><ha-card></ha-card>`;
    }
    this._ensureResizeObserver();
    this._updateSizeMode(this.clientWidth);

    this._wheelHandler = (e) => {
      const tree = this.shadowRoot?.querySelector(".tree");
      if (!tree) return;
      const canScrollDown = e.deltaY > 0 && tree.scrollTop < tree.scrollHeight - tree.clientHeight;
      const canScrollUp   = e.deltaY < 0 && tree.scrollTop > 0;
      if (canScrollDown || canScrollUp) {
        e.preventDefault();
        tree.scrollTop += e.deltaY;
      }
    };
    this.addEventListener("wheel", this._wheelHandler, { passive: false });
    this._startSyncLoop();
  }

  disconnectedCallback() {
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }
    if (this._wheelHandler) {
      this.removeEventListener("wheel", this._wheelHandler);
      this._wheelHandler = null;
    }
    this._stopSyncLoop();
  }

  _startSyncLoop() {
    this._syncLoopActive = true;
    let prevTop = null;
    const loop = () => {
      if (!this._syncLoopActive) return;
      requestAnimationFrame(loop);
      const col   = this.shadowRoot?.querySelector(".master-col");
      const panel = this.shadowRoot?.querySelector(".master-panel");
      if (!col || !panel) return;
      const colRect = col.getBoundingClientRect();
      const top = Math.round(colRect.top);
      if (top === prevTop) return;
      prevTop = top;
      // Visible slice of master-col within the viewport.
      const visibleTop    = Math.max(0, colRect.top);
      const visibleBottom = Math.min(window.innerHeight, colRect.bottom);
      if (visibleBottom <= visibleTop) return;
      // Center the panel in the visible slice, clamped inside master-col.
      const center = (visibleTop + visibleBottom) / 2;
      const offset = Math.max(0, Math.min(
        center - panel.offsetHeight / 2 - colRect.top,
        colRect.height - panel.offsetHeight
      ));
      panel.style.transform = offset > 0 ? `translateY(${Math.round(offset)}px)` : "";
    };
    requestAnimationFrame(loop);
  }

  _stopSyncLoop() {
    this._syncLoopActive = false;
  }

  setConfig(config) {
    if (!config?.entity) {
      const msg = `fritzmesh-card: \`entity\` is missing or empty. ` +
        `Received config: ${JSON.stringify(config)}`;
      console.error(msg);
      throw new Error(msg);
    }
    const nodeSort = config.node_sort ?? "default";
    if (!["default", "name", "ip", "mac"].includes(nodeSort)) {
      throw new Error("fritzmesh-card: node_sort must be 'default', 'name', 'ip', or 'mac'");
    }
    const transferMetricMode = config.transfer_metric_mode ?? "none";
    if (!["none", "aggregate", "max_single", "average"].includes(transferMetricMode)) {
      throw new Error(
        "fritzmesh-card: transfer_metric_mode must be 'none', 'aggregate', 'max_single', or 'average'"
      );
    }
    const hideOfflineNodes = config.hide_offline_nodes === true;
    this._config = {
      ...config,
      url_template: config.url_template ?? "http://{ip}",
      node_sort: nodeSort,
      transfer_metric_mode: transferMetricMode,
      hide_offline_nodes: hideOfflineNodes,
      line_color: sanitizeHexColor(config.line_color, "#4caf50"),
      accent_color: sanitizeHexColor(config.accent_color, "#1976d2"),
      text_dim_color: sanitizeHexColor(config.text_dim_color, "#888888"),
      master_panel_start_color: sanitizeHexColor(config.master_panel_start_color, "#1565c0"),
      master_panel_end_color: sanitizeHexColor(config.master_panel_end_color, "#1e88e5"),
      font_scale: sanitizeFontScale(config.font_scale, 100),
    };

    this._lastKey = "";
    if (this._hass) this._render();
  }

  /**
   * Build a cache key from all entities that affect the rendered topology:
   *   • the configured master sensor
   *   • all sensors with the same fritz_unique_id (slave nodes)
   *   • all device_tracker entities that carry a connected_to attribute
   */
  set hass(hass) {
    if (!this._config) return;
    this._hass = hass;

    const masterState = hass?.states?.[this._config.entity];
    const fritzUid = masterState?.attributes?.fritz_unique_id;

    const keyParts = { master: masterState?.attributes, masterState: masterState?.state };

    if (fritzUid) {
      const slaveAttrs = {};
      const switchAttrs = {};
      const trackerStates = {};
      for (const [eid, s] of Object.entries(hass.states)) {
        const a = s?.attributes ?? {};
        if (eid.startsWith("sensor.") && a.fritz_unique_id === fritzUid && a.is_master === false) {
          if (a.node_type === "switch") {
            switchAttrs[eid] = a;
          } else {
            slaveAttrs[eid] = a;
          }
        } else if (eid.startsWith("device_tracker.") && a.connected_to) {
          trackerStates[eid] = { state: s.state, attributes: a };
        }
      }
      keyParts.slaves = slaveAttrs;
      keyParts.switches = switchAttrs;
      keyParts.trackers = trackerStates;
    }

    const key = JSON.stringify(keyParts);
    if (key === this._lastKey) return;
    this._lastKey = key;

    try {
      this._render();
    } catch (e) {
      console.error("fritzmesh-card render error:", e);
      this._setHTML("", `<div class="msg warn">${ICON.unknown}<span>Render error: <code>${esc(String(e))}</code></span></div>`);
    }
  }

  getCardSize() {
    return Math.max(4, Math.ceil((this._nodeCount * 3 + this._clientCount) / 4));
  }

  getGridOptions() {
    return {
      columns: 9,
      rows: 3,
      min_columns: 4,
      max_columns: 12,
      min_rows: 2,
      max_rows: 8,
    };
  }

  // ── Render ────────────────────────────────────────────────────────────────

  /**
   * Main render method: build topology from fritz integration entities.
   *
   * 1. Read master node attrs from the configured sensor entity.
   * 2. Discover slave nodes: sensors with matching fritz_unique_id and is_master=false.
   * 3. Assign clients: device_tracker entities whose connected_to matches a node name.
   * 4. Determine slave uplink type from the slave's device_tracker (if found).
   */
  _render() {
    const title = this._config.title ?? "";

    const state = this._hass?.states?.[this._config.entity];

    if (!state || state.state === "unavailable") {
      this._setHTML(title, `
        <div class="msg warn">
          ${ICON.unknown}
          Entity <code>${esc(this._config.entity)}</code> is unavailable.
        </div>`);
      return;
    }

    const masterAttrs = state.attributes ?? {};
    const fritzUid  = masterAttrs.fritz_unique_id;
    const fritzHost = masterAttrs.fritz_host ?? "";

    if (!fritzUid) {
      this._setHTML(title, `
        <div class="msg warn">
          ${ICON.unknown}
          Entity <code>${esc(this._config.entity)}</code> is not a master mesh node sensor
          (missing <code>fritz_unique_id</code> attribute).
        </div>`);
      return;
    }

    // Build master node object.
    const masterNode = {
      name: masterAttrs.node_name ?? "Fritz!Box",
      is_master: true,
      node_uid: masterAttrs.node_uid ?? "",
      rx_rate_kbps: masterAttrs.rx_rate_kbps ?? null,
      tx_rate_kbps: masterAttrs.tx_rate_kbps ?? null,
      clients: [],
    };

    // Discover slave and switch nodes from hass.states.
    const slaveNodes = [];
    const switchNodes = [];
    const nodesByName = { [masterNode.name]: masterNode };

    for (const [eid, s] of Object.entries(this._hass.states)) {
      const a = s?.attributes ?? {};
      if (
        eid.startsWith("sensor.") &&
        a.fritz_unique_id === fritzUid &&
        a.is_master === false &&
        a.node_name
      ) {
        if (a.node_type === "switch") {
          const switchNode = {
            name: a.node_name,
            is_master: false,
            node_type: "switch",
            node_uid: a.node_uid ?? "",
            rx_rate_kbps: a.rx_rate_kbps ?? null,
            tx_rate_kbps: a.tx_rate_kbps ?? null,
            clients: [],
          };
          switchNodes.push(switchNode);
          nodesByName[a.node_uid] = switchNode;
        } else {
          const slave = {
            name: a.node_name,
            is_master: false,
            node_uid: a.node_uid ?? "",
            rx_rate_kbps: a.rx_rate_kbps ?? null,
            tx_rate_kbps: a.tx_rate_kbps ?? null,
            parent_link_type: "LAN", // resolved below
            parent_node: a.parent_node ?? null, // set by backend for LAN-backhaul slaves
            clients: [],
          };
          slaveNodes.push(slave);
          nodesByName[a.node_name] = slave;
        }
      }
    }

    // Assign clients from device_tracker entities.
    // Also capture the mesh SSID from the first connected WiFi client found.
    let meshSsid = null;
    for (const [eid, s] of Object.entries(this._hass.states)) {
      if (!eid.startsWith("device_tracker.")) continue;
      const a = s?.attributes ?? {};
      const connectedTo = a.connected_to;
      if (!connectedTo || !(connectedTo in nodesByName)) continue;

      if (!meshSsid && a.ssid && a.connection_type === "WLAN") {
        meshSsid = a.ssid;
      }

      const node = nodesByName[connectedTo];
      node.clients.push({
        name: a.host_name || a.friendly_name,
        mac: a.mac,
        ip: a.ip,
        connection_type: a.connection_type,
        wifi_band: a.wifi_band ?? null,
        // node_name is set on slave device_trackers — used to identify them
        // as mesh nodes rather than regular client devices.
        node_name: a.node_name ?? null,
        connection_state: s.state === "home" ? "CONNECTED" : "DISCONNECTED",
        cur_rx_kbps: a.cur_rx_kbps ?? null,
        cur_tx_kbps: a.cur_tx_kbps ?? null,
        ha_entity_id: eid,
      });
    }

    // Determine each slave's uplink type from its device_tracker (if present).
    // parent_node from the sensor attribute takes priority and is not overwritten.
    if (slaveNodes.length) {
      for (const slave of slaveNodes) {
        if (!slave.node_uid) continue;
        const macNorm = slave.node_uid.toUpperCase().replace(/[^0-9A-F]/g, "");
        for (const [eid, s] of Object.entries(this._hass.states)) {
          if (!eid.startsWith("device_tracker.")) continue;
          const a = s?.attributes ?? {};
          const tMac = String(a.mac || "").toUpperCase().replace(/[^0-9A-F]/g, "");
          if (tMac && tMac === macNorm) {
            slave.parent_link_type = a.connection_type || "LAN";
            if (!slave.parent_node) slave.parent_node = a.connected_to ?? null;
            break;
          }
        }
      }
    }

    // Attach slaves whose uplink goes via a switch as children of that switch.
    // They will be rendered nested inside the switch section instead of at root.
    const switchKeysByMac = new Set(switchNodes.map((sw) => sw.node_uid));
    for (const slave of slaveNodes) {
      if (slave.parent_node && switchKeysByMac.has(slave.parent_node)) {
        const parentSwitch = nodesByName[slave.parent_node];
        parentSwitch.slaveChildren = parentSwitch.slaveChildren ?? [];
        parentSwitch.slaveChildren.push(slave);
        slave._renderedUnderSwitch = true;
      }
    }

    if (!masterNode.clients.length && !slaveNodes.length && !switchNodes.length) {
      this._setHTML(title,
        `<div class="msg">No topology data yet — waiting for first coordinator update.</div>`);
      return;
    }

    // Update size tracking for getCardSize().
    this._nodeCount   = 1 + slaveNodes.length + switchNodes.length;
    this._clientCount = Object.values(nodesByName).reduce((s, n) => s + n.clients.length, 0);

    // Remove switch-attached slaves from the root list and from the switch's
    // plain client rows (they'll be rendered as nested slave sections instead).
    const switchChildNames = new Set(
      slaveNodes.filter((s) => s._renderedUnderSwitch).map((s) => s.name)
    );
    for (const sw of switchNodes) {
      sw.clients = sw.clients.filter((c) => !switchChildNames.has(c.node_name));
    }

    let slaves = this._sortSlaveNodes(
      slaveNodes.filter((s) => !s._renderedUnderSwitch)
    );
    if (this._config.hide_offline_nodes) {
      slaves = slaves.filter((node) => this._isNodeOnline(node));
    }

    this._setHTML(
      title,
      this._masterPanel(masterNode, fritzHost, meshSsid),
      this._masterSection(masterNode)
        + slaves.map((node) => this._slaveSection(node)).join("")
        + switchNodes.map((node) => this._switchSection(node)).join("")
    );
  }

  // ── Left panel ─────────────────────────────────────────────────────────────

  _masterPanel(node, host, ssid) {
    const nodeRates = this._nodeRateLabel(node);
    return `
      <div class="master-panel">
        <div class="mp-icon"><ha-icon icon="mdi:router-network-wireless"></ha-icon></div>
        <div class="mp-name">${esc(node?.name ?? "Fritz!Box")}</div>
        ${host ? `<div class="mp-ip">${esc(host)}</div>` : ""}
        ${nodeRates ? `<div class="mp-rate">${ICON.transfer}<span>${esc(nodeRates)}</span></div>` : ""}
        <div class="mp-badge">HEIMNETZ</div>
        ${ssid ? `<div class="mp-ssid"><ha-icon icon="mdi:wifi"></ha-icon><span>${esc(ssid)}</span></div>` : ""}
      </div>`;
  }

  // ── Master section ─────────────────────────────────────────────────────────

  _masterSection(node) {
    const clients = this._sortClients(this._visibleClients([...(node?.clients ?? [])]));
    return `
      <div class="section">
        <div class="clients">
          ${clients.length
            ? clients.map((c) => this._clientRow(c)).join("")
            : '<div class="no-clients">No direct clients</div>'}
        </div>
      </div>`;
  }

  // ── Slave section ──────────────────────────────────────────────────────────

  _slaveSection(node) {
    const clients  = this._sortClients(this._visibleClients([...(node?.clients ?? [])]));
    const nodeRates = this._nodeRateLabel(node);
    const linkType = node.parent_link_type || "LAN";
    const isWifi   = linkType === "WLAN";
    const nodeBadge = isWifi ? "WIFI REPEATER" : "REPEATER";
    const nodeIcon = `<ha-icon icon="mdi:access-point-network"></ha-icon>`;
    const uplinkSpd = fmtSpeed(node.rx_rate_kbps);
    const linkLabel = (isWifi ? "WiFi" : "LAN") + (uplinkSpd ? ` → ${uplinkSpd}` : "");

    return `
      <div class="section">
        <div class="section-row">
          <div class="h-line ${isWifi ? "wifi" : "lan"}"></div>
          <span class="row-label ${isWifi ? "wifi-label" : "lan-label"}">${esc(linkLabel)}</span>
          <div class="slave-card">
            <div class="sc-icon ${isWifi ? "sc-wifi" : "sc-lan"}">${nodeIcon}</div>
            <div class="sc-info">
              <div class="sc-name">${esc(node.name)}</div>
              ${nodeRates ? `<div class="sc-rate">${ICON.transfer}<span>${esc(nodeRates)}</span></div>` : ""}
              <div class="sc-badge">${nodeBadge}</div>
            </div>
          </div>
        </div>
        <div class="clients clients--indented">
          ${clients.length
            ? clients.map((c) => this._clientRow(c)).join("")
            : '<div class="no-clients">No clients</div>'}
        </div>
      </div>`;
  }

  // ── Switch section ─────────────────────────────────────────────────────────
ve
  _switchSection(node) {
    const clients  = this._sortClients(this._visibleClients([...(node?.clients ?? [])]));
    const nodeRates = this._nodeRateLabel(node);
    const uplinkSpd = fmtSpeed(node.rx_rate_kbps);
    const linkLabel = uplinkSpd ? `LAN → ${uplinkSpd}` : "LAN";
    const slaveChildren = this._sortSlaveNodes(node.slaveChildren ?? []);

    return `
      <div class="section">
        <div class="section-row">
          <div class="h-line lan"></div>
          <span class="row-label lan-label">${esc(linkLabel)}</span>
          <div class="slave-card">
            <div class="sc-icon sc-lan"><ha-icon icon="mdi:switch"></ha-icon></div>
            <div class="sc-info">
              <div class="sc-name">${esc(node.name)}</div>
              ${nodeRates ? `<div class="sc-rate">${ICON.transfer}<span>${esc(nodeRates)}</span></div>` : ""}
              <div class="sc-badge">SWITCH</div>
            </div>
          </div>
        </div>
        <div class="clients clients--indented">
          ${clients.length
            ? clients.map((c) => this._clientRow(c)).join("")
            : (slaveChildren.length ? "" : '<div class="no-clients">No clients</div>')}
          ${slaveChildren.map((s) => this._slaveSection(s)).join("")}
        </div>
      </div>`;
  }

  // ── Client row ─────────────────────────────────────────────────────────────

  _clientRow(client) {
    const on    = client.connection_state === "CONNECTED";
    const wifi  = client.connection_type  === "WLAN";
    const label = connLabel(client);
    const name  = client.name || client.mac || "?";
    const ip    = client.ip || "";
    const entityId = client.ha_entity_id || "";

    return `
      <div class="client-row${on ? "" : " off"}">
        <div class="cl-line ${wifi ? "wifi" : "lan"}"></div>
        <span class="cl-label">${esc(label)}</span>
        <span class="cl-icon"><ha-icon icon="${wifi ? "mdi:wifi" : "mdi:lan-connect"}"></ha-icon></span>
        <button
          type="button"
          class="cl-name client-action"
          data-click-source="name"
          data-entity-id="${encodeURIComponent(entityId)}"
          data-ip="${encodeURIComponent(ip)}"
        >${esc(name)}</button>
        ${ip
          ? `<button
              type="button"
              class="cl-ip client-action"
              data-click-source="ip"
              data-entity-id="${encodeURIComponent(entityId)}"
              data-ip="${encodeURIComponent(ip)}"
            >${esc(ip)}</button>`
          : ""
        }
      </div>`;
  }

  // ── Scaffold ───────────────────────────────────────────────────────────────

  /**
   * _setHTML(title, masterHtml, treeHtml)
   *
   * First call: builds the full shadow DOM skeleton.
   * Subsequent calls: patches only .master-col and .tree in-place,
   * preserving the tree element (and its scrollTop) across updates.
   *
   * Error/warning paths may pass a single body string as masterHtml with no
   * treeHtml — in that case the whole card-body is replaced as before.
   */
  _setHTML(title, masterHtml, treeHtml) {
    const sr = this.shadowRoot;
    const cfgStyles = this._configStyles();
    const isFullContent = treeHtml !== undefined;

    const haCard = sr.querySelector("ha-card");
    if (!haCard) {
      // ── First render: build the full skeleton ──
      const bodyHtml = isFullContent
        ? `<div class="master-col">${masterHtml}</div><div class="tree">${treeHtml}</div>`
        : masterHtml;
      sr.innerHTML = `
        <style>${STYLES}${cfgStyles}</style>
        <ha-card>
          ${title ? `<div class="card-header">${esc(title)}</div>` : ""}
          <div class="card-body">${bodyHtml}</div>
        </ha-card>`;
      this._updateSizeMode(this.clientWidth);
      this._wireClientActions();
      return;
    }

    // ── Subsequent renders: patch in-place ──
    sr.querySelector("style").textContent = STYLES + cfgStyles;

    // Header
    const hdr = sr.querySelector(".card-header");
    if (title && !hdr) {
      const el = document.createElement("div");
      el.className = "card-header";
      el.textContent = title;
      haCard.prepend(el);
    } else if (!title && hdr) {
      hdr.remove();
    } else if (title && hdr && hdr.textContent !== title) {
      hdr.textContent = title;
    }

    const cardBody = sr.querySelector(".card-body");
    if (!isFullContent) {
      // Error / warning path: replace entire card-body
      cardBody.innerHTML = masterHtml;
    } else {
      // Normal path: patch master-col and tree independently
      const masterCol = sr.querySelector(".master-col");
      if (masterCol) {
        const prevTransform = sr.querySelector(".master-panel")?.style.transform ?? "";
        masterCol.innerHTML = masterHtml;
        const newPanel = masterCol.querySelector(".master-panel");
        if (newPanel && prevTransform) newPanel.style.transform = prevTransform;
      }
      const tree = sr.querySelector(".tree");
      if (tree) {
        const scrollTop = tree.scrollTop;
        tree.innerHTML = treeHtml;
        tree.scrollTop = scrollTop;
      }
    }

    this._updateSizeMode(this.clientWidth);
    this._wireClientActions();
  }

  _wireClientActions() {
    const actionEls = this.shadowRoot.querySelectorAll(".client-action");
    actionEls.forEach((el) => {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        this._handleClientAction(el);
      });
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          e.stopPropagation();
          this._handleClientAction(el);
        }
      });
    });
  }

  _handleClientAction(el) {
    const source = el.dataset.clickSource || "name";
    const entityId = decodeURIComponent(el.dataset.entityId || "");
    const ip = decodeURIComponent(el.dataset.ip || "");

    if (source === "ip") {
      this._openClientUrl(ip);
      return;
    }
    this._openMoreInfo(entityId);
  }

  _openMoreInfo(entityId) {
    if (!entityId) {
      console.warn("[fritzmesh-card] no mapped HA entity_id found for more-info click");
      return;
    }
    this.dispatchEvent(new CustomEvent("hass-more-info", {
      bubbles: true,
      composed: true,
      detail: { entityId },
    }));
  }

  _openClientUrl(ip) {
    if (!ip) return;
    const url = this._buildClientUrl(ip);
    if (!url) return;
    window.open(url, "_blank", "noopener,noreferrer");
  }

  _buildClientUrl(ip) {
    const template = this._config?.url_template || "http://{ip}";
    let url = template.includes("{ip}") ? template.replaceAll("{ip}", ip) : `${template}${ip}`;
    if (!/^https?:\/\//i.test(url)) {
      url = `http://${url}`;
    }
    return url;
  }

  _nodeRateLabel(node) {
    if (!node) return "";
    const mode = this._config?.transfer_metric_mode ?? "none";
    const clients = Array.isArray(node.clients) ? node.clients : [];

    let txKbps = 0;
    let rxKbps = 0;
    let labelPrefix = "";

    if (mode === "none") {
      return "";
    } else if (mode === "max_single") {
      txKbps = clients.reduce((m, c) => Math.max(m, c?.cur_tx_kbps || 0), 0);
      rxKbps = clients.reduce((m, c) => Math.max(m, c?.cur_rx_kbps || 0), 0);
      labelPrefix = "Max ";
    } else if (mode === "average") {
      const count = clients.length || 0;
      if (count > 0) {
        txKbps = Math.round(
          clients.reduce((s, c) => s + Math.max(0, c?.cur_tx_kbps || 0), 0) / count
        );
        rxKbps = Math.round(
          clients.reduce((s, c) => s + Math.max(0, c?.cur_rx_kbps || 0), 0) / count
        );
      }
      labelPrefix = "Avg ";
    } else {
      // aggregate — sum client rates directly, consistent with max_single / average
      txKbps = clients.reduce((s, c) => s + Math.max(0, c?.cur_tx_kbps || 0), 0);
      rxKbps = clients.reduce((s, c) => s + Math.max(0, c?.cur_rx_kbps || 0), 0);
      labelPrefix = "Agg ";
    }

    const tx = fmtSpeed(txKbps);
    const rx = fmtSpeed(rxKbps);
    if (!tx && !rx) return "";
    if (tx && rx) return `${labelPrefix}TX ${tx} / RX ${rx}`;
    return tx ? `${labelPrefix}TX ${tx}` : `${labelPrefix}RX ${rx}`;
  }

  _sortSlaveNodes(nodes) {
    const mode = this._config?.node_sort ?? "default";
    if (mode === "default") return nodes;
    const sorted = [...nodes];
    if (mode === "name") {
      sorted.sort((a, b) => this._compareName(a?.name, b?.name));
      return sorted;
    }
    if (mode === "mac") {
      sorted.sort((a, b) => this._compareMac(a?.node_uid, b?.node_uid) || this._compareName(a?.name, b?.name));
      return sorted;
    }
    if (mode === "ip") {
      // Slave nodes don't have an IP in their sensor attrs; sort by name.
      sorted.sort((a, b) => this._compareName(a?.name, b?.name));
      return sorted;
    }
    return nodes;
  }

  _isNodeOnline(node) {
    if (!node || node.is_master) return true;
    // Without uplink state data, assume online (slave is registered in HA).
    return true;
  }

  _visibleClients(clients) {
    if (!this._config?.hide_offline_nodes) return clients;
    return clients.filter((c) => c?.connection_state === "CONNECTED");
  }

  _sortClients(clients) {
    const mode = this._config?.node_sort ?? "default";
    if (mode === "default") {
      return [...clients].sort(clientSort);
    }
    const sorted = [...clients];
    if (mode === "name") {
      sorted.sort((a, b) => this._compareName(a?.name || a?.mac, b?.name || b?.mac));
      return sorted;
    }
    if (mode === "mac") {
      sorted.sort((a, b) => this._compareMac(a?.mac, b?.mac) || this._compareName(a?.name || a?.mac, b?.name || b?.mac));
      return sorted;
    }
    if (mode === "ip") {
      sorted.sort((a, b) => this._compareIp(a?.ip, b?.ip) || this._compareMac(a?.mac, b?.mac) || this._compareName(a?.name || a?.mac, b?.name || b?.mac));
      return sorted;
    }
    return [...clients].sort(clientSort);
  }

  _compareIp(a, b) {
    const pa = this._ipParts(a);
    const pb = this._ipParts(b);
    if (!pa && !pb) return 0;
    if (!pa) return 1;
    if (!pb) return -1;
    for (let i = 0; i < 4; i += 1) {
      if (pa[i] !== pb[i]) return pa[i] - pb[i];
    }
    return 0;
  }

  _compareMac(a, b) {
    const ma = this._macParts(a);
    const mb = this._macParts(b);
    if (!ma && !mb) {
      return this._normString(a).localeCompare(this._normString(b));
    }
    if (!ma) return 1;
    if (!mb) return -1;
    for (let i = 0; i < 6; i += 1) {
      if (ma[i] !== mb[i]) return ma[i] - mb[i];
    }
    return 0;
  }

  _ipParts(ip) {
    const s = String(ip || "").trim().split("/", 1)[0];
    const parts = s.split(".");
    if (parts.length !== 4) return null;
    const out = [];
    for (const p of parts) {
      const n = Number(p);
      if (!Number.isInteger(n) || n < 0 || n > 255) return null;
      out.push(n);
    }
    return out;
  }

  _macParts(mac) {
    const s = String(mac || "").toLowerCase().replace(/[^0-9a-f]/g, "");
    if (s.length !== 12) return null;
    const out = [];
    for (let i = 0; i < 12; i += 2) {
      const n = Number.parseInt(s.slice(i, i + 2), 16);
      if (!Number.isFinite(n)) return null;
      out.push(n);
    }
    return out;
  }

  _compareName(a, b) {
    return this._normString(a).localeCompare(this._normString(b));
  }

  _normString(v) {
    return String(v || "").trim().toLowerCase();
  }

  _configStyles() {
    const lineColor = sanitizeHexColor(this._config?.line_color, "#4caf50");
    const accentColor = sanitizeHexColor(this._config?.accent_color, "#1976d2");
    const textDimColor = sanitizeHexColor(this._config?.text_dim_color, "#888888");
    const masterPanelStart = sanitizeHexColor(this._config?.master_panel_start_color, "#1565c0");
    const masterPanelEnd = sanitizeHexColor(this._config?.master_panel_end_color, "#1e88e5");
    const fontScale = sanitizeFontScale(this._config?.font_scale, 100);
    return `
:host {
  --green: ${lineColor};
  --green-fade: ${hexToRgba(lineColor, 0.18)};
  --blue: ${accentColor};
  --text-dim: ${textDimColor};
  --master-panel-start: ${masterPanelStart};
  --master-panel-end: ${masterPanelEnd};
  --fm-font-scale: ${fontScale}%;
}
`;
  }

  _ensureResizeObserver() {
    if (this._resizeObserver) return;
    this._resizeObserver = new ResizeObserver((entries) => {
      const width = entries?.[0]?.contentRect?.width ?? this.clientWidth;
      this._updateSizeMode(width);
    });
    this._resizeObserver.observe(this);
  }

  _updateSizeMode(width) {
    const mode = width < 520 ? "compact" : width < 760 ? "medium" : "full";
    if (mode === this._sizeMode) return;
    this._sizeMode = mode;
    this.setAttribute("data-size", mode);
  }
}

// ── Visual editor ─────────────────────────────────────────────────────────────

class FritzMeshCardEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = {};
    this._hass   = null;
  }

  setConfig(config) {
    this._config = { ...config };
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    this._render();
  }

  _render() {
    const entities = this._applicableEntities();
    const currentEntity = this._config.entity ?? "";
    const currentTitle = this._config.title ?? "";
    const currentUrlTemplate = this._config.url_template ?? "http://{ip}";
    const currentNodeSort = this._config.node_sort ?? "default";
    const currentTransferMetricMode = this._config.transfer_metric_mode ?? "none";
    const currentHideOfflineNodes = this._config.hide_offline_nodes === true;
    const currentLineColor = sanitizeHexColor(this._config.line_color, "#4caf50");
    const currentAccentColor = sanitizeHexColor(this._config.accent_color, "#1976d2");
    const currentTextDimColor = sanitizeHexColor(this._config.text_dim_color, "#888888");
    const currentMasterPanelStart = sanitizeHexColor(this._config.master_panel_start_color, "#1565c0");
    const currentMasterPanelEnd = sanitizeHexColor(this._config.master_panel_end_color, "#1e88e5");
    const currentFontScale = sanitizeFontScale(this._config.font_scale, 100);

    this.shadowRoot.innerHTML = `
      <style>
        .card-config {
          display: flex;
          flex-direction: column;
          gap: 12px;
          padding: 12px 0;
        }
        label {
          display: block;
          font-size: 0.86rem;
          font-weight: 600;
          margin-bottom: 6px;
        }
        select,
        input {
          box-sizing: border-box;
          width: 100%;
          padding: 8px;
          border-radius: 6px;
          border: 1px solid var(--divider-color, #d0d0d0);
          background: var(--card-background-color, #fff);
          color: var(--primary-text-color, #111);
          font: inherit;
        }
        .hint {
          margin-top: 4px;
          font-size: 0.78rem;
          color: var(--secondary-text-color, #777);
        }
        .toggle-row {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-bottom: 0;
        }
        .toggle-row input[type="checkbox"] {
          width: auto;
          margin: 0;
          padding: 0;
        }
      </style>
      <div class="card-config">
        <div>
          <label for="entity-select">Master node sensor (required)</label>
          <select id="entity-select">
            <option value="">Select an entity...</option>
            ${entities.map((entityId) => `
              <option value="${esc(entityId)}" ${entityId === currentEntity ? "selected" : ""}>
                ${esc(entityId)}
              </option>
            `).join("")}
          </select>
          <div class="hint">
            Only fritz integration master node sensors are shown (those with <code>is_master: true</code>).
          </div>
        </div>

        <div>
          <label for="entity-input">Or enter entity id manually</label>
          <input
            id="entity-input"
            type="text"
            placeholder="sensor.fritz_box_mesh_connected_devices"
            value="${esc(currentEntity)}"
          />
        </div>

        <div>
          <label for="title-input">Card title (optional)</label>
          <input
            id="title-input"
            type="text"
            placeholder="Fritz!Box Mesh Topology"
            value="${esc(currentTitle)}"
          />
          <div class="hint">Leave empty to use default title.</div>
        </div>

        <div>
          <label for="node-sort">Node sorting</label>
          <select id="node-sort">
            <option value="default" ${currentNodeSort === "default" ? "selected" : ""}>Default</option>
            <option value="name" ${currentNodeSort === "name" ? "selected" : ""}>By name</option>
            <option value="ip" ${currentNodeSort === "ip" ? "selected" : ""}>By IP</option>
            <option value="mac" ${currentNodeSort === "mac" ? "selected" : ""}>By MAC</option>
          </select>
          <div class="hint">Sorts slave/repeater nodes in the topology list.</div>
        </div>

        <div>
          <label for="transfer-metric-mode">Transfer metric mode</label>
          <select id="transfer-metric-mode">
            <option value="none" ${currentTransferMetricMode === "none" ? "selected" : ""}>None</option>
            <option value="aggregate" ${currentTransferMetricMode === "aggregate" ? "selected" : ""}>Aggregate</option>
            <option value="max_single" ${currentTransferMetricMode === "max_single" ? "selected" : ""}>Max single client</option>
            <option value="average" ${currentTransferMetricMode === "average" ? "selected" : ""}>Average client</option>
          </select>
          <div class="hint">Controls TX/RX metric shown on master and repeater cards.</div>
        </div>

        <div>
          <label class="toggle-row" for="hide-offline-nodes">
            <input
              id="hide-offline-nodes"
              type="checkbox"
              ${currentHideOfflineNodes ? "checked" : ""}
            />
            <span>Hide offline clients</span>
          </label>
          <div class="hint">Hides disconnected clients from all node sections.</div>
        </div>

        <div>
          <label for="url-template">URL template (for IP clicks)</label>
          <input
            id="url-template"
            type="text"
            placeholder="http://{ip}"
            value="${esc(currentUrlTemplate)}"
          />
          <div class="hint">Use <code>{ip}</code> as placeholder, e.g. <code>https://{ip}</code>.</div>
        </div>

        <div>
          <label for="line-color">Line color</label>
          <input id="line-color" type="color" value="${esc(currentLineColor)}" />
        </div>

        <div>
          <label for="accent-color">Accent color</label>
          <input id="accent-color" type="color" value="${esc(currentAccentColor)}" />
        </div>

        <div>
          <label for="text-dim-color">Secondary text color</label>
          <input id="text-dim-color" type="color" value="${esc(currentTextDimColor)}" />
        </div>

        <div>
          <label for="font-scale">Font size scale (%)</label>
          <input id="font-scale" type="number" min="80" max="140" step="1" value="${esc(String(currentFontScale))}" />
          <div class="hint">Scales all card text from 80% to 140%.</div>
        </div>

        <div>
          <label for="master-panel-start-color">Master panel gradient start</label>
          <input id="master-panel-start-color" type="color" value="${esc(currentMasterPanelStart)}" />
        </div>

        <div>
          <label for="master-panel-end-color">Master panel gradient end</label>
          <input id="master-panel-end-color" type="color" value="${esc(currentMasterPanelEnd)}" />
        </div>
      </div>`;

    const entitySelect = this.shadowRoot.querySelector("#entity-select");
    const entityInput = this.shadowRoot.querySelector("#entity-input");
    const titleInput = this.shadowRoot.querySelector("#title-input");
    const nodeSortInput = this.shadowRoot.querySelector("#node-sort");
    const transferMetricModeInput = this.shadowRoot.querySelector("#transfer-metric-mode");
    const hideOfflineNodesInput = this.shadowRoot.querySelector("#hide-offline-nodes");
    const urlTemplateInput = this.shadowRoot.querySelector("#url-template");
    const lineColorInput = this.shadowRoot.querySelector("#line-color");
    const accentColorInput = this.shadowRoot.querySelector("#accent-color");
    const textDimColorInput = this.shadowRoot.querySelector("#text-dim-color");
    const fontScaleInput = this.shadowRoot.querySelector("#font-scale");
    const masterPanelStartColorInput = this.shadowRoot.querySelector("#master-panel-start-color");
    const masterPanelEndColorInput = this.shadowRoot.querySelector("#master-panel-end-color");

    entitySelect?.addEventListener("change", (e) => {
      const val = e.target.value;
      const cfg = { ...this._config };
      if (val) cfg.entity = val;
      this._dispatch(cfg);
      if (entityInput) entityInput.value = val;
    });

    entityInput?.addEventListener("change", (e) => {
      const val = e.target.value?.trim();
      const cfg = { ...this._config };
      if (val) cfg.entity = val;
      else delete cfg.entity;
      this._dispatch(cfg);
    });

    titleInput?.addEventListener("change", (e) => {
      const val = e.target.value;
      const cfg = { ...this._config };
      if (val !== "") cfg.title = val;
      else delete cfg.title;
      this._dispatch(cfg);
    });

    nodeSortInput?.addEventListener("change", (e) => {
      const val = e.target.value;
      const cfg = { ...this._config, node_sort: val };
      this._dispatch(cfg);
    });

    transferMetricModeInput?.addEventListener("change", (e) => {
      const val = e.target.value;
      const cfg = { ...this._config, transfer_metric_mode: val };
      this._dispatch(cfg);
    });

    hideOfflineNodesInput?.addEventListener("change", (e) => {
      const cfg = { ...this._config };
      if (e.target.checked) cfg.hide_offline_nodes = true;
      else delete cfg.hide_offline_nodes;
      this._dispatch(cfg);
    });

    urlTemplateInput?.addEventListener("change", (e) => {
      const val = e.target.value?.trim();
      const cfg = { ...this._config };
      if (val) cfg.url_template = val;
      else delete cfg.url_template;
      this._dispatch(cfg);
    });

    lineColorInput?.addEventListener("change", (e) => {
      const cfg = { ...this._config, line_color: sanitizeHexColor(e.target.value, "#4caf50") };
      this._dispatch(cfg);
    });

    accentColorInput?.addEventListener("change", (e) => {
      const cfg = { ...this._config, accent_color: sanitizeHexColor(e.target.value, "#1976d2") };
      this._dispatch(cfg);
    });

    textDimColorInput?.addEventListener("change", (e) => {
      const cfg = { ...this._config, text_dim_color: sanitizeHexColor(e.target.value, "#888888") };
      this._dispatch(cfg);
    });

    fontScaleInput?.addEventListener("change", (e) => {
      const cfg = { ...this._config, font_scale: sanitizeFontScale(e.target.value, 100) };
      this._dispatch(cfg);
    });

    masterPanelStartColorInput?.addEventListener("change", (e) => {
      const cfg = {
        ...this._config,
        master_panel_start_color: sanitizeHexColor(e.target.value, "#1565c0"),
      };
      this._dispatch(cfg);
    });

    masterPanelEndColorInput?.addEventListener("change", (e) => {
      const cfg = {
        ...this._config,
        master_panel_end_color: sanitizeHexColor(e.target.value, "#1e88e5"),
      };
      this._dispatch(cfg);
    });
  }

  _dispatch(config) {
    this._config = config;
    this.dispatchEvent(new CustomEvent("config-changed", {
      detail:   { config },
      bubbles:  true,
      composed: true,
    }));
  }

  /**
   * Filter entity picker to master mesh node sensors from the fritz integration.
   * These carry is_master === true and fritz_unique_id in their attributes.
   */
  _isApplicableEntity(entityId) {
    if (!entityId || !entityId.startsWith("sensor.")) return false;

    const state = this._hass?.states?.[entityId];
    const attrs = state?.attributes ?? {};

    // Primary signal: sensor has is_master flag from the fritz integration.
    if (attrs.is_master === true) return true;

    // Fallback for early startup when state may not yet be loaded.
    return Boolean(attrs.fritz_unique_id) && attrs.is_master !== false;
  }

  _applicableEntities() {
    if (!this._hass?.states) return [];
    return Object.keys(this._hass.states)
      .filter((entityId) => this._isApplicableEntity(entityId))
      .sort((a, b) => a.localeCompare(b));
  }
}

// ── Styles ────────────────────────────────────────────────────────────────────

const STYLES = `
/* ── CSS custom properties (theme integration) ── */
:host {
  display: block;
  height: 100%;
  min-height: 0;
  max-height: 100dvh;
  font-size: var(--fm-font-scale, 100%);
  --green:      #4caf50;
  --green-fade: rgba(76,175,80,.18);
  --blue-dark:  #1565c0;
  --blue:       #1976d2;
  --text-dim:   var(--secondary-text-color, #888);
  --card-bg:    var(--card-background-color, #fff);
  --divider:    var(--divider-color, #e0e0e0);
  --sec-bg:     var(--secondary-background-color, #f5f5f5);
}
ha-card {
  overflow: hidden;
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

/* ── Card header ── */
.card-header {
  padding: 14px 16px 10px;
  font-size: 1.05em;
  font-weight: 700;
  color: var(--primary-text-color);
  border-bottom: 1px solid var(--divider);
}
.card-body {
  padding: 12px 14px 16px;
  overflow: clip;
  flex: 1;
  min-height: 0;
  box-sizing: border-box;
  display: flex;
  flex-direction: row;
  gap: 0;
  align-items: stretch;
}

/* ── LEFT: full-height column for the master panel ── */
.master-col {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  align-items: stretch;
}

/* ── LEFT: master Fritz!Box panel (sits at top of .master-col) ── */
.master-panel {
  flex-shrink: 0;
  width: 152px;
  background: linear-gradient(155deg, var(--master-panel-start, #1565c0) 0%, var(--master-panel-end, #1e88e5) 100%);
  color: #fff;
  border-radius: 12px 0 0 12px;
  padding: 14px 12px;
  box-shadow: 0 3px 10px rgba(21,101,192,.4);
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 3px;
  align-self: flex-start;
}
.mp-icon { width: 52px; height: 52px; color: rgba(255,255,255,.9); margin-bottom: 2px; display: flex; align-items: center; justify-content: center; }
.mp-icon ha-icon { --mdc-icon-size: 52px; display: flex; }
.mp-name  { font-weight: 700; font-size: .9em; line-height: 1.25; }
.mp-ip    { font-size: .72em; font-family: monospace; opacity: .9; }
.mp-rate {
  margin-top: 4px;
  font-size: .66em;
  opacity: .92;
  display: flex;
  align-items: center;
  gap: 4px;
}
.mp-rate svg { width: 12px; height: 12px; }
.mp-badge {
  margin-top: 8px;
  background: rgba(255,255,255,.22);
  border-radius: 4px;
  padding: 2px 10px;
  font-size: .66em;
  font-weight: 800;
  letter-spacing: .1em;
}
.mp-ssid {
  margin-top: 6px;
  font-size: .66em;
  opacity: .85;
  display: flex;
  align-items: center;
  gap: 4px;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mp-ssid ha-icon { --mdc-icon-size: 12px; display: flex; flex-shrink: 0; }
.mp-ssid span { overflow: hidden; text-overflow: ellipsis; }

/* ── RIGHT: tree column ── */
.tree {
  flex: 1;
  min-width: 0;
  min-height: 0;
  align-self: stretch;
  overflow-y: auto;
  border-left: 4px solid var(--master-panel-end, #1e88e5);
  padding-left: 8px;
}

/* Medium cards */
:host([data-size="medium"]) .card-body { gap: 0; }
:host([data-size="medium"]) .master-panel { width: 132px; padding: 12px 10px; }
:host([data-size="medium"]) .mp-icon { width: 44px; height: 44px; }
:host([data-size="medium"]) .mp-icon ha-icon { --mdc-icon-size: 44px; }
:host([data-size="medium"]) .cl-label { min-width: 96px; }
:host([data-size="medium"]) .cl-line { width: 34px; }

/* Compact cards */
:host([data-size="compact"]) .card-body {
  flex-direction: column;
  gap: 10px;
}
:host([data-size="compact"]) .master-col {
  flex-direction: row;
}
:host([data-size="compact"]) .master-panel {
  position: static;
  width: auto;
  max-width: none;
  align-self: stretch;
  flex: 1;
  border-radius: 10px;
}
:host([data-size="compact"]) .tree {
  border-left: none;
  margin-left: 0;
}
:host([data-size="compact"]) .section {
  padding-left: 0;
}
:host([data-size="compact"]) .section-row::before {
  display: none;
}
:host([data-size="compact"]) .h-line,
:host([data-size="compact"]) .cl-line {
  width: 14px;
}
:host([data-size="compact"]) .clients {
  margin-left: 0;
  padding-left: 0;
}
:host([data-size="compact"]) .clients--indented {
  margin-left: 0;
  background: none;
}
:host([data-size="compact"]) .clients--indented::before {
  display: none;
}
:host([data-size="compact"]) .slave-card {
  min-width: 0;
  max-width: 100%;
}
:host([data-size="compact"]) .cl-label {
  min-width: 78px;
}

/* ── Section ── */
.section {
  padding: 10px 0 6px 22px;
  position: relative;
}
.section:last-child {
  padding-bottom: 2px;
}

/* ── Section row ── */
.section-row {
  display: flex;
  align-items: center;
  gap: 5px;
  position: relative;
  margin-bottom: 6px;
}
.section-row::before {
  content: "";
  position: absolute;
  left: -22px;
  top: 50%;
  transform: translateY(-50%);
  width: 22px;
  height: 2px;
  background: var(--green);
}

/* ── Horizontal extension line ── */
.h-line {
  height: 2px;
  width: 22px;
  flex-shrink: 0;
}
.h-line.lan  { background: var(--green); }
.h-line.wifi {
  background-image: repeating-linear-gradient(
    to right, var(--green) 0, var(--green) 5px,
    transparent 5px, transparent 10px);
}

/* ── Row label ── */
.row-label {
  font-size: .68em;
  font-weight: 600;
  white-space: nowrap;
  flex-shrink: 0;
  border-radius: 3px;
  padding: 1px 6px;
  border: 1px solid var(--green-fade);
  color: var(--green);
  background: var(--green-fade);
}
.wifi-label { color: #66bb6a; border-color: rgba(102,187,106,.3); background: rgba(102,187,106,.1); }
.lan-label  { color: var(--green); }

/* ── Slave repeater card ── */
.slave-card {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 7px 11px 7px 9px;
  border-radius: 9px;
  background: var(--sec-bg);
  border: 1px solid var(--divider);
  flex-shrink: 0;
  min-width: 120px;
  max-width: 220px;
}

.sc-icon      { width: 26px; height: 26px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; }
.sc-icon ha-icon { --mdc-icon-size: 26px; display: flex; }
.sc-lan       { color: var(--blue); }
.sc-wifi      { color: #43a047; }

.sc-info  { min-width: 0; }
.sc-name  { font-weight: 700; font-size: .88em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sc-rate {
  margin-top: 2px;
  font-size: .66em;
  color: var(--text-dim);
  display: flex;
  align-items: center;
  gap: 4px;
}
.sc-rate svg { width: 12px; height: 12px; }
.sc-badge {
  display: inline-block;
  margin-top: 4px;
  background: var(--blue);
  color: #fff;
  font-size: .6em;
  font-weight: 800;
  letter-spacing: .07em;
  padding: 1px 5px;
  border-radius: 3px;
}

/* ── Client list ── */
.clients {
  display: flex;
  flex-direction: column;
  gap: 1px;
  margin-left: -22px;
  padding-left: 0;
}

/* Slave / switch client list: hangs from the node card, not the root line */
.clients--indented {
  margin-left: 44px;
  padding-left: 2px;
  position: relative;
  /* gradient stops at centre of last client row (13px = min-height 26px / 2) */
  background: linear-gradient(var(--green), var(--green)) 0 0 / 2px calc(100% - 13px) no-repeat;
}
/* Extend the line upward into the gap between the node card and the client
   list without moving the client rows themselves. */
.clients--indented::before {
  content: "";
  position: absolute;
  left: 0;
  bottom: 100%;
  width: 2px;
  height: 28px;
  background: var(--green);
}

/* ── Individual client row ── */
.client-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 26px;
  padding: 2px 0;
}
.client-row.off { opacity: .38; }

.cl-line       { flex-shrink: 0; width: 48px; height: 2px; }
.cl-line.lan   { background: var(--green); }
.cl-line.wifi  {
  background-image: repeating-linear-gradient(
    to right, var(--green) 0, var(--green) 5px,
    transparent 5px, transparent 10px);
}

.cl-label {
  font-size: .7em;
  color: var(--text-dim);
  min-width: 118px;
  flex-shrink: 0;
  white-space: nowrap;
}

.cl-icon      { width: 15px; height: 15px; flex-shrink: 0; color: var(--text-dim); display: flex; align-items: center; justify-content: center; }
.cl-icon svg  { width: 100%; height: 100%; }
.cl-icon ha-icon { --mdc-icon-size: 15px; display: flex; }

.cl-name { font-size: .84em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.client-row:not(.off) .cl-name { color: var(--blue); font-weight: 500; }

.cl-ip { font-size: .68em; font-family: monospace; color: var(--text-dim); white-space: nowrap; margin-left: 2px; flex-shrink: 0; }

/* Click actions */
.client-action {
  border: 0;
  padding: 0;
  margin: 0;
  background: transparent;
  text-align: left;
  cursor: pointer;
  font: inherit;
}
.client-action:hover {
  text-decoration: underline;
}
.client-action:focus-visible {
  outline: 2px solid var(--blue);
  outline-offset: 1px;
  border-radius: 2px;
}

.no-clients { font-size: .8em; color: var(--text-dim); font-style: italic; padding: 4px 0; }

/* ── Status / error messages ── */
.msg       { display: flex; align-items: center; gap: 10px; padding: 16px 0; font-size: .9em; color: var(--text-dim); }
.msg.warn  { color: var(--warning-color, #e6a817); }
.msg svg   { width: 24px; height: 24px; flex-shrink: 0; }
`;

// ── Registration ──────────────────────────────────────────────────────────────

if (!customElements.get("fritzmesh-card")) {
  customElements.define("fritzmesh-card", FritzMeshCard);
  customElements.define("fritzmesh-card-editor", FritzMeshCardEditor);

  (function _rebuildLovelace(retriesLeft) {
    const huiRoot = document
      .querySelector("home-assistant")
      ?.shadowRoot?.querySelector("home-assistant-main")
      ?.shadowRoot?.querySelector("ha-panel-lovelace")
      ?.shadowRoot?.querySelector("hui-root");

    if (huiRoot) {
      console.info("[fritzmesh-card] dispatching ll-rebuild → hui-root");
      huiRoot.dispatchEvent(new Event("ll-rebuild"));
    } else if (retriesLeft > 0) {
      setTimeout(() => _rebuildLovelace(retriesLeft - 1), 250);
    } else {
      console.warn("[fritzmesh-card] hui-root not found after retries");
    }
  })(20);

  console.info(
    `%c FRITZMESH-CARD %c v${CARD_VERSION} `,
    "color:#fff;background:#1565c0;font-weight:700;padding:2px 4px;border-radius:3px 0 0 3px",
    "color:#1565c0;background:#fff;font-weight:700;padding:2px 4px;border-radius:0 3px 3px 0;border:1px solid #1565c0"
  );
}

window.customCards ??= [];
window.customCards.push({
  type:        "fritzmesh-card",
  name:        "Fritz!Box Mesh Topology",
  description: "Visualises which devices are connected to which mesh node.",
  preview:     false,
});
