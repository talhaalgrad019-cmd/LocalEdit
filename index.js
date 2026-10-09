(function () {
  "use strict";

  const { findByProps, findByStoreName } = vendetta.metro;
  const common = vendetta.metro.common;
  const FluxDispatcher = common.FluxDispatcher;
  const React = common.React;
  const RN = common.ReactNative;
  const { after } = vendetta.patcher;
  const storage = vendetta.plugin.storage;

  const REAPPLY_TYPES = /^(MESSAGE_CREATE|MESSAGE_UPDATE|LOAD_MESSAGES)/;

  const unpatches = [];
  const pending = {};
  let installed = false;
  let installTimer = null;
  let ChannelStore = null;
  let MessageStore = null;
  let SelectedChannelStore = null;
  let RestAPI = null;
  let guardTimer = null;
  let styles = null;

  // ---------- helpers ----------

  function toast(msg) {
    try { vendetta.ui.toasts.showToast(msg); } catch (e) {}
  }

  function edits() {
    if (!storage.localEdits || typeof storage.localEdits !== "object" || Array.isArray(storage.localEdits)) {
      storage.localEdits = {};
    }
    return storage.localEdits;
  }

  function keyOf(channelId, id) {
    return channelId + ":" + id;
  }

  function currentChannelId() {
    try {
      SelectedChannelStore = SelectedChannelStore || findByStoreName("SelectedChannelStore");
      return (SelectedChannelStore && SelectedChannelStore.getChannelId()) || "";
    } catch (e) {
      return "";
    }
  }

  function guildOf(channelId) {
    try {
      ChannelStore = ChannelStore || findByStoreName("ChannelStore");
      const ch = ChannelStore && ChannelStore.getChannel(channelId);
      return (ch && (ch.guild_id || ch.guildId)) || undefined;
    } catch (e) {
      return undefined;
    }
  }

  function copy(text) {
    try {
      const cb = findByProps("setString");
      if (cb && cb.setString) cb.setString(text);
    } catch (e) {}
  }

  // What does Discord's own chat memory hold for this message right now?
  function storeInfo(channelId, id) {
    try {
      MessageStore = MessageStore || findByStoreName("MessageStore");
      const m = MessageStore && MessageStore.getMessage(channelId, id);
      if (!m) return { inStore: false };
      return {
        inStore: true,
        content: m.content,
        attachmentCount: m.attachments ? Array.from(m.attachments).length : 0,
        keys: Object.keys(m).slice(0, 40),
      };
    } catch (e) {
      return { inStore: false, error: String(e) };
    }
  }

  function wait(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function attKey(list) {
    try {
      return Array.from(list || []).map(function (a) { return a && a.url; }).join("|");
    } catch (e) {
      return "";
    }
  }

  function schedule(key, fn) {
    // dispatching inside a dispatch throws, so always defer
    if (pending[key]) return;
    pending[key] = true;
    setTimeout(function () {
      try { fn(); } catch (e) { console.error("[LocalEdit] dispatch failed", e); }
      delete pending[key];
    }, 0);
  }

  // Crash guard: if Discord crashes while rendering an edit, clear saved edits on next start
  function armGuard() {
    storage.guard = Date.now();
    clearTimeout(guardTimer);
    guardTimer = setTimeout(function () { delete storage.guard; }, 4000);
  }

  // ---------- loading the real message from Discord (read-only request) ----------

  function fetchMessage(channelId, id) {
    RestAPI = RestAPI || findByProps("get", "post", "del", "patch");
    if (!RestAPI) return Promise.reject(new Error("REST module not found"));
    return RestAPI.get({
      url: "/channels/" + channelId + "/messages",
      query: { limit: 1, around: id },
    }).then(function (res) {
      const list = res && res.body;
      const msg = Array.isArray(list)
        ? list.filter(function (m) { return m && m.id === id; })[0]
        : null;
      if (!msg) throw new Error("Message not found in that channel");
      return msg;
    });
  }

  // ---------- applying edits (local only: nothing is sent to Discord) ----------

  function sendMessage(msg, channelId) {
    const gid = guildOf(channelId);
    const out = Object.assign({}, msg);
    if (gid && !out.guild_id) out.guild_id = gid;
    armGuard();
    FluxDispatcher.dispatch({
      type: "MESSAGE_UPDATE",
      guildId: gid,
      message: out,
      __localEdit: true,
    });
  }

  function applyStored(e) {
    if (!e || !e.raw) return;
    sendMessage(
      Object.assign({}, e.raw, {
        content: e.content,
        attachments: e.attachments,
        edited_timestamp: e.editedAt,
      }),
      e.channelId
    );
  }

  function removeEdit(channelId, id) {
    const all = edits();
    const k = keyOf(channelId, id);
    const e = all[k];
    if (!e) return false;
    if (e.raw) sendMessage(e.raw, channelId); // raw = the original, as Discord sent it
    delete all[k];
    return true;
  }

  // Re-apply saved edits when Discord (re)loads those messages
  function collect(value, out, seen, depth) {
    if (!value || depth > 8 || out.length >= 200) return out;
    if (typeof value !== "object" || seen.has(value)) return out;
    seen.add(value);
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) collect(value[i], out, seen, depth + 1);
      return out;
    }
    if (value.id && (value.channel_id || value.channelId)) out.push(value);
    const keys = Object.keys(value).slice(0, 40);
    for (let i = 0; i < keys.length; i++) collect(value[keys[i]], out, seen, depth + 1);
    return out;
  }

  function reapply(action) {
    if (!action || action.__localEdit) return;
    const all = edits();
    if (!Object.keys(all).length) return;

    // opening a channel: re-apply its saved edits once its messages have loaded
    if (action.type === "CHANNEL_SELECT" && action.channelId) {
      Object.keys(all).forEach(function (k) {
        const e = all[k];
        if (e.channelId !== action.channelId) return;
        setTimeout(function () { schedule(k + ":select", function () { applyStored(e); }); }, 800);
      });
      return;
    }

    if (!REAPPLY_TYPES.test(String(action.type))) return;
    collect(action, [], new Set(), 0).forEach(function (m) {
      const k = keyOf(m.channel_id || m.channelId, m.id);
      const e = all[k];
      if (!e) return;
      if (typeof m.content !== "string" && m.attachments === undefined) return;
      if (m.content === e.content && attKey(m.attachments) === attKey(e.attachments)) return;
      schedule(k, function () { applyStored(e); });
    });
  }

  // ---------- images ----------

  function sizeOf(url) {
    return new Promise(function (resolve) {
      let done = false;
      function finish(w, h) {
        if (done) return;
        done = true;
        resolve({ width: w, height: h });
      }
      try {
        RN.Image.getSize(url, function (w, h) { finish(w, h); }, function () { finish(512, 384); });
      } catch (e) {
        finish(512, 384);
      }
      setTimeout(function () { finish(512, 384); }, 4000);
    });
  }

  function guessType(url) {
    const m = String(url).split("?")[0].toLowerCase().match(/\.(png|jpe?g|gif|webp)$/);
    if (!m) return "image/png";
    return m[1] === "gif" ? "image/gif" : m[1] === "webp" ? "image/webp" : m[1] === "png" ? "image/png" : "image/jpeg";
  }

  function buildAttachments(urls, rawAttachments) {
    const existing = Array.from(rawAttachments || []);
    return Promise.all(
      urls.map(function (url, i) {
        const same = existing.filter(function (a) { return a && a.url === url; })[0];
        if (same) return same;
        return sizeOf(url).then(function (dim) {
          return {
            id: String(Date.now()) + i,
            filename: String(url).split("?")[0].split("/").pop() || "image.png",
            size: 0,
            url: url,
            proxy_url: url,
            width: dim.width,
            height: dim.height,
            content_type: guessType(url),
          };
        });
      })
    );
  }

  function saveEdit(channelId, raw, text, urls) {
    return buildAttachments(urls, raw.attachments).then(function (atts) {
      const all = edits();
      all[keyOf(channelId, raw.id)] = {
        channelId: channelId,
        id: raw.id,
        raw: raw,
        content: text,
        attachments: atts,
        editedAt: new Date().toISOString(),
      };
      applyStored(all[keyOf(channelId, raw.id)]);
    });
  }

  // ---------- settings page ----------

  function getStyles() {
    if (!styles) {
      const C = vendetta.ui.semanticColors;
      const text = C.TEXT_NORMAL || C.HEADER_SECONDARY;
      styles = common.stylesheet.createThemedStyleSheet({
        page: { padding: 16, paddingBottom: 60 },
        title: { color: text, fontSize: 20, fontWeight: "700" },
        hint: { color: C.TEXT_MUTED, fontSize: 13, marginTop: 4, marginBottom: 6 },
        label: { color: C.TEXT_MUTED, fontSize: 12, fontWeight: "600", marginTop: 16, marginBottom: 6 },
        input: {
          color: text,
          backgroundColor: "rgba(127,127,127,0.18)",
          borderRadius: 8,
          paddingHorizontal: 12,
          paddingVertical: 10,
          fontSize: 16,
          minHeight: 44,
          textAlignVertical: "top",
        },
        box: {
          backgroundColor: "rgba(127,127,127,0.12)",
          borderRadius: 8,
          padding: 12,
        },
        boxText: { color: text, fontSize: 15 },
        btn: { paddingVertical: 13, borderRadius: 8, alignItems: "center", marginTop: 14 },
        primary: { backgroundColor: "#5865F2" },
        secondary: { backgroundColor: "rgba(127,127,127,0.3)" },
        danger: { backgroundColor: "#da373c" },
        disabled: { opacity: 0.45 },
        btnText: { color: "#FFFFFF", fontWeight: "700", fontSize: 15 },
        status: { color: C.TEXT_MUTED, fontSize: 13, marginTop: 14 },
      });
    }
    return styles;
  }

  function Button(props) {
    const st = getStyles();
    return React.createElement(
      RN.TouchableOpacity,
      {
        style: [st.btn, st[props.kind || "primary"], props.disabled ? st.disabled : null],
        disabled: !!props.disabled,
        onPress: props.onPress,
      },
      React.createElement(RN.Text, { style: st.btnText }, props.label)
    );
  }

  function SettingsPage() {
    const st = getStyles();
    const channelState = React.useState(currentChannelId());
    const messageState = React.useState("");
    const loadedState = React.useState(null); // { shown, edited, author }
    const textState = React.useState("");
    const linksState = React.useState("");
    const statusState = React.useState("");
    const busyState = React.useState(false);
    const rawRef = React.useRef(null);
    const debugRef = React.useRef("");

    const channelId = channelState[0];
    const messageId = messageState[0];
    const loaded = loadedState[0];
    const busy = busyState[0];

    function ids() {
      const c = String(channelId || "").trim();
      const m = String(messageId || "").trim();
      if (!/^\d+$/.test(c) || !/^\d+$/.test(m)) return null;
      return { c: c, m: m };
    }

    function load() {
      const id = ids();
      if (!id) {
        statusState[1]("Enter the channel ID and message ID (numbers only).");
        return;
      }
      busyState[1](true);
      statusState[1]("Loading...");
      fetchMessage(id.c, id.m)
        .then(function (raw) {
          rawRef.current = raw;
          const existing = edits()[keyOf(id.c, id.m)];
          const shown = existing ? existing.content : raw.content || "";
          const urls = (existing ? existing.attachments : raw.attachments || []).map(function (a) { return a.url; });
          loadedState[1]({
            shown: shown,
            edited: !!existing,
            author: raw.author ? raw.author.global_name || raw.author.username : "",
          });
          textState[1](shown);
          linksState[1](urls.join(" "));
          statusState[1]("Loaded. Change the text below, then press Update.");
        })
        .catch(function (e) {
          loadedState[1](null);
          statusState[1]("Could not load: " + (e && e.message ? e.message : String(e)));
        })
        .then(function () { busyState[1](false); });
    }

    function update() {
      const id = ids();
      const raw = rawRef.current;
      if (!id || !raw || raw.id !== id.m) {
        statusState[1]("Press Load message first.");
        return;
      }
      const text = String(textState[0] || "");
      const urls = String(linksState[0] || "")
        .split(/\s+/)
        .filter(function (u) { return /^https?:\/\//i.test(u); });
      if (!text && !urls.length) {
        statusState[1]("Add some text or an image link.");
        return;
      }
      busyState[1](true);
      const before = storeInfo(id.c, id.m);
      saveEdit(id.c, raw, text, urls)
        .then(function () { return wait(600); })
        .then(function () {
          let info = storeInfo(id.c, id.m);
          if (info.inStore && info.content !== text) {
            // try once more in case the first update raced with something
            applyStored(edits()[keyOf(id.c, id.m)]);
            return wait(600).then(function () { return storeInfo(id.c, id.m); });
          }
          return info;
        })
        .then(function (info) {
          debugRef.current = JSON.stringify(
            { channel: id.c, message: id.m, expected: text, before: before, after: info },
            null,
            1
          );
          loadedState[1]({ shown: text, edited: true, author: loaded ? loaded.author : "" });
          if (!info.inStore) {
            statusState[1]("Saved, but Discord doesn't have this message loaded right now. Open the channel and scroll to it. The edit applies by itself when it loads.");
          } else if (info.content === text) {
            statusState[1]("Done. Discord's chat now has the new text. Go back to the channel to see it.");
            toast("Edited locally");
          } else {
            statusState[1]("Discord ignored the update (its copy still has the old text). Tap Copy debug info and send it to me.");
          }
        })
        .catch(function (e) {
          statusState[1]("Update failed: " + (e && e.message ? e.message : String(e)));
        })
        .then(function () { busyState[1](false); });
    }

    function remove() {
      const id = ids();
      if (!id) return;
      if (removeEdit(id.c, id.m)) {
        statusState[1]("Local edit removed.");
        toast("Local edit removed");
        load();
      }
    }

    return React.createElement(
      RN.ScrollView,
      { contentContainerStyle: st.page, keyboardShouldPersistTaps: "handled" },
      React.createElement(RN.Text, { style: st.title }, "Local Edit"),
      React.createElement(
        RN.Text,
        { style: st.hint },
        "Changes how a message looks for you only. Nothing is sent to Discord. Turn on Developer Mode in Discord to copy message IDs."
      ),

      React.createElement(RN.Text, { style: st.label }, "CHANNEL ID (filled with the channel you had open)"),
      React.createElement(RN.TextInput, {
        style: st.input,
        value: channelId,
        onChangeText: channelState[1],
        keyboardType: "numeric",
        placeholder: "Channel ID",
        placeholderTextColor: "#8e9297",
      }),

      React.createElement(RN.Text, { style: st.label }, "MESSAGE ID"),
      React.createElement(RN.TextInput, {
        style: st.input,
        value: messageId,
        onChangeText: messageState[1],
        keyboardType: "numeric",
        placeholder: "Message ID",
        placeholderTextColor: "#8e9297",
      }),

      React.createElement(Button, { label: busy ? "Please wait..." : "Load message", onPress: load, disabled: busy }),

      loaded
        ? React.createElement(
            React.Fragment,
            null,
            React.createElement(
              RN.Text,
              { style: st.label },
              "CURRENT TEXT" + (loaded.author ? " (by " + loaded.author + ")" : "") + (loaded.edited ? " - locally edited" : "")
            ),
            React.createElement(
              RN.View,
              { style: st.box },
              React.createElement(RN.Text, { style: st.boxText, selectable: true }, loaded.shown || "(no text)")
            ),

            React.createElement(RN.Text, { style: st.label }, "NEW TEXT"),
            React.createElement(RN.TextInput, {
              style: st.input,
              value: textState[0],
              onChangeText: textState[1],
              multiline: true,
              placeholder: "New message text",
              placeholderTextColor: "#8e9297",
            }),

            React.createElement(RN.Text, { style: st.label }, "IMAGE LINKS (space between links, optional)"),
            React.createElement(RN.TextInput, {
              style: st.input,
              value: linksState[0],
              onChangeText: linksState[1],
              multiline: true,
              autoCapitalize: "none",
              autoCorrect: false,
              placeholder: "https://...",
              placeholderTextColor: "#8e9297",
            }),

            React.createElement(Button, { label: "Update", onPress: update, disabled: busy }),
            loaded.edited
              ? React.createElement(Button, { label: "Remove local edit", kind: "danger", onPress: remove, disabled: busy })
              : null
          )
        : null,

      statusState[0] ? React.createElement(RN.Text, { style: st.status }, statusState[0]) : null,
      loaded
        ? React.createElement(Button, {
            label: "Copy debug info",
            kind: "secondary",
            onPress: function () {
              copy(debugRef.current || "no update yet");
              toast("Debug info copied");
            },
          })
        : null
    );
  }

  // ---------- startup ----------

  function tryInstall() {
    if (installed) return;
    try {
      if (!FluxDispatcher) return;

      if (storage.guard) {
        // last session ended right after applying an edit: assume it crashed, drop saved edits
        storage.localEdits = {};
        delete storage.guard;
        toast("LocalEdit: last edit crashed the chat, saved edits cleared");
      }

      unpatches.push(after("dispatch", FluxDispatcher, function (args) { reapply(args[0]); }));
      installed = true;

      if (installTimer) {
        clearInterval(installTimer);
        installTimer = null;
      }
      Object.keys(edits()).forEach(function (k) {
        const e = edits()[k];
        schedule(k, function () { applyStored(e); });
      });
    } catch (e) {
      console.error("[LocalEdit] install failed", e);
    }
  }

  return {
    default: {
      onLoad: function () {
        tryInstall();
        if (!installed) installTimer = setInterval(tryInstall, 2000);
      },
      onUnload: function () {
        if (installTimer) {
          clearInterval(installTimer);
          installTimer = null;
        }
        clearTimeout(guardTimer);
        unpatches.forEach(function (u) {
          try { u(); } catch (e) {}
        });
        unpatches.length = 0;
        installed = false;
      },
      settings: SettingsPage,
    },
    __esModule: true,
  };
})(); 
