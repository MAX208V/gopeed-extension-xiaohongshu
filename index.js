gopeed.events.onResolve(async function (ctx) {
  var url = ctx.req.url;
  var settings = gopeed.settings || {};
  var cookie = settings.cookie || "";
  var ua = settings.userAgent || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

  // --- 1. 解析 URL，提取 noteId ---
  var noteId = extractNoteId(url);

  // 短链：用 fetch 跟随重定向
  if (!noteId && url.indexOf("xhslink.com") !== -1) {
    var resp = await fetch(url, {
      redirect: "follow",
      headers: { "User-Agent": ua }
    });
    var finalUrl = resp.url || url;
    noteId = extractNoteId(finalUrl);
    if (!noteId) {
      throw new MessageError("无法从短链解析笔记 ID，最终地址: " + finalUrl);
    }
    url = finalUrl;
  }

  if (!noteId) {
    throw new MessageError("无法从链接解析笔记 ID: " + url);
  }

  gopeed.logger.info("笔记 ID: " + noteId);

  var targetUrl = "https://www.xiaohongshu.com/explore/" + noteId;
  var noteData = null;

  // --- 2. 方案 A：WebView（推荐，能完整渲染页面） ---
  if (gopeed.runtime.webview && gopeed.runtime.webview.isAvailable()) {
    gopeed.logger.info("使用 WebView 解析...");
    noteData = await parseViaWebView(targetUrl, noteId, cookie, ua);
  }

  // --- 3. 方案 B：fetch + SSR 解析（部分笔记可用） ---
  if (!noteData) {
    gopeed.logger.info("尝试 fetch SSR 解析...");
    noteData = await parseViaFetch(targetUrl, noteId, cookie, ua);
  }

  if (!noteData) {
    throw new MessageError(
      "无法解析笔记数据。\n" +
      "可能原因：\n" +
      "1. 笔记已删除或设为私密\n" +
      "2. 当前环境不支持 WebView（Docker/Linux 无桌面）\n" +
      "3. 需要在扩展设置中填写有效 Cookie\n\n" +
      "建议：在 Gopeed 桌面版中使用本扩展，并设置 Cookie。"
    );
  }

  // --- 4. 提取媒体文件 ---
  var title = noteData.title || noteData.desc || noteId;
  var noteType = noteData.type;
  var files = [];

  gopeed.logger.info("标题: " + title + ", 类型: " + (noteType || "未知"));

  // 图文笔记
  if (noteType === "normal" || (!noteType && noteData.imageList)) {
    var imageList = noteData.imageList || [];
    for (var i = 0; i < imageList.length; i++) {
      var img = imageList[i];
      var imgUrl = img.urlDefault || img.url || "";
      if (!imgUrl && img.infoList && img.infoList.length > 0) {
        var sorted = img.infoList.slice().sort(function (a, b) {
          return (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0);
        });
        imgUrl = sorted[0].url || "";
      }
      if (imgUrl) {
        if (imgUrl.indexOf("//") === 0) imgUrl = "https:" + imgUrl;
        var ext = guessImageExt(imgUrl);
        files.push({
          name: padNumber(i + 1, 2) + ext,
          req: { url: imgUrl }
        });
      }
    }
  }

  // 视频笔记
  if (noteType === "video" || (noteData.video && noteData.video.media)) {
    var videoUrl = extractVideoUrl(noteData);
    if (videoUrl) {
      if (videoUrl.indexOf("//") === 0) videoUrl = "https:" + videoUrl;
      files.push({ name: "video.mp4", req: { url: videoUrl } });
    }
  }

  if (files.length === 0) {
    throw new MessageError("未找到可下载的媒体。笔记类型: " + (noteType || "未知"));
  }

  var safeTitle = title.replace(/[\\/:*?"<>|]/g, "_").substring(0, 80);
  ctx.res = {
    name: safeTitle + "_" + noteId,
    files: files
  };
  gopeed.logger.info("完成，共 " + files.length + " 个文件");
});

// ========== WebView 解析 ==========

async function parseViaWebView(targetUrl, noteId, cookie, ua) {
  var page;
  try {
    page = await gopeed.runtime.webview.open({
      headless: true,
      title: "XHS Parser",
      width: 1280,
      height: 900
    });

    // 设置 Cookie（如果提供了）
    if (cookie) {
      var cookies = parseCookieString(cookie, "www.xiaohongshu.com");
      await page.setCookies(cookies);
    }

    await page.goto(targetUrl, {
      waitUntil: "networkidle",
      timeoutMs: 20000
    });

    // 等待页面渲染
    await sleep(2000);

    // 从 DOM 中提取笔记数据
    var result = await page.execute(function () {
      // 优先从 __INITIAL_STATE__ 取
      if (window.__INITIAL_STATE__) {
        var state = window.__INITIAL_STATE__;
        if (state.note && state.note.noteDetailMap) {
          var map = state.note.noteDetailMap;
          var keys = Object.keys(map);
          for (var i = 0; i < keys.length; i++) {
            var entry = map[keys[i]];
            var note = entry.note || entry;
            if (note.imageList || note.video || note.type) {
              return JSON.parse(JSON.stringify(note));
            }
          }
        }
      }

      // 备选：从页面元素提取图片
      var imgs = document.querySelectorAll(
        '.note-image img, .swiper-slide img, [class*="note"] img'
      );
      if (imgs.length > 0) {
        var imageList = [];
        imgs.forEach(function (img) {
          var src = img.src || img.getAttribute("data-src") || "";
          if (src && src.indexOf("xhscdn") !== -1) {
            imageList.push({ urlDefault: src });
          }
        });
        if (imageList.length > 0) {
          return { type: "normal", imageList: imageList, title: document.title };
        }
      }

      // 备选：视频
      var videoEl = document.querySelector("video source, video");
      if (videoEl) {
        var videoSrc = videoEl.src || videoEl.getAttribute("src") || "";
        if (videoSrc) {
          return {
            type: "video",
            title: document.title,
            video: { url: videoSrc }
          };
        }
      }

      return null;
    });

    return result;
  } catch (e) {
    gopeed.logger.warn("WebView 解析失败: " + e.message);
    return null;
  } finally {
    if (page) {
      try { await page.close(); } catch (e) {}
    }
  }
}

// ========== Fetch SSR 解析 ==========

async function parseViaFetch(targetUrl, noteId, cookie, ua) {
  var headers = {
    "User-Agent": ua,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Referer": "https://www.xiaohongshu.com/"
  };
  if (cookie) headers["Cookie"] = cookie;

  var resp = await fetch(targetUrl, { headers: headers });
  if (!resp.ok) return null;

  var html = await resp.text();
  var state = extractInitialState(html);
  if (!state) return null;

  return findNoteData(state, noteId);
}

// ========== 工具函数 ==========

function extractNoteId(url) {
  var m = url.match(/xiaohongshu\.com\/(?:explore|discovery\/item)\/([a-fA-F0-9]{24})/);
  if (m) return m[1];
  m = url.match(/xiaohongshu\.com\/explore\/([a-fA-F0-9]+)/);
  if (m) return m[1];
  return null;
}

function extractInitialState(html) {
  var marker = "window.__INITIAL_STATE__=";
  var idx = html.indexOf(marker);
  if (idx === -1) {
    marker = "window.__INITIAL_STATE__ =";
    idx = html.indexOf(marker);
  }
  if (idx === -1) return null;

  var start = idx + marker.length;
  var end = html.indexOf("</script>", start);
  if (end === -1) end = html.length;

  var raw = html.substring(start, end).trim();
  if (raw.charAt(raw.length - 1) === ";") raw = raw.substring(0, raw.length - 1);
  raw = raw.replace(/\bundefined\b/g, "null");

  try { return JSON.parse(raw); } catch (e) { return null; }
}

function findNoteData(state, noteId) {
  try {
    if (state.note && state.note.noteDetailMap) {
      var map = state.note.noteDetailMap;
      if (map[noteId]) return map[noteId].note || map[noteId];
      var keys = Object.keys(map);
      for (var i = 0; i < keys.length; i++) {
        var entry = map[keys[i]];
        if (entry.note) return entry.note;
        if (entry.imageList || entry.video) return entry;
      }
    }
    if (state.note && state.note.detail) return state.note.detail;
    if (state.noteData) return state.noteData;
    return deepFindNote(state, noteId);
  } catch (e) { return null; }
}

function deepFindNote(obj, noteId) {
  if (!obj || typeof obj !== "object") return null;
  if (obj.id === noteId && (obj.imageList || obj.video || obj.type)) return obj;
  var keys = Object.keys(obj);
  for (var i = 0; i < keys.length; i++) {
    var val = obj[keys[i]];
    if (val && typeof val === "object") {
      var found = deepFindNote(val, noteId);
      if (found) return found;
    }
  }
  return null;
}

function extractVideoUrl(noteData) {
  try {
    var video = noteData.video;
    if (!video) return null;

    // media.stream.h264
    if (video.media && video.media.stream) {
      var stream = video.media.stream;
      var h264 = stream.h264 || stream.H264 || [];
      if (h264.length > 0) {
        var best = h264[0];
        for (var i = 1; i < h264.length; i++) {
          if ((h264[i].videoBitrate || 0) > (best.videoBitrate || 0)) best = h264[i];
        }
        return best.masterUrl || best.url;
      }
      var fmts = ["h265", "H265", "av1", "AV1"];
      for (var f = 0; f < fmts.length; f++) {
        var arr = stream[fmts[f]];
        if (arr && arr.length > 0) return arr[0].masterUrl || arr[0].url;
      }
    }

    if (video.url) return video.url;

    if (video.consumer && video.consumer.originVideoKey) {
      return "https://sns-video-bd.xhscdn.com/" + video.consumer.originVideoKey;
    }
  } catch (e) {}
  return null;
}

function parseCookieString(cookieStr, domain) {
  var cookies = [];
  var pairs = cookieStr.split(";");
  for (var i = 0; i < pairs.length; i++) {
    var pair = pairs[i].trim();
    var eqIdx = pair.indexOf("=");
    if (eqIdx === -1) continue;
    cookies.push({
      name: pair.substring(0, eqIdx).trim(),
      value: pair.substring(eqIdx + 1).trim(),
      domain: domain,
      path: "/"
    });
  }
  return cookies;
}

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function guessImageExt(url) {
  if (url.indexOf(".png") !== -1) return ".png";
  if (url.indexOf(".gif") !== -1) return ".gif";
  if (url.indexOf(".webp") !== -1) return ".webp";
  return ".jpg";
}

function padNumber(n, len) {
  var s = "" + n;
  while (s.length < len) s = "0" + s;
  return s;
}
