gopeed.events.onResolve(async function (ctx) {
  var url = ctx.req.url;
  var settings = gopeed.settings || {};
  var cookie = settings.cookie || "";
  var ua = settings.userAgent || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

  var headers = {
    "User-Agent": ua,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Referer": "https://www.xiaohongshu.com/"
  };
  if (cookie) {
    headers["Cookie"] = cookie;
  }

  // --- 1. 解析 URL，提取 noteId ---
  var noteId = extractNoteId(url);

  // 短链：先跟随重定向拿到真实 URL
  if (!noteId && url.indexOf("xhslink.com") !== -1) {
    var resp = await fetch(url, { redirect: "follow", headers: headers });
    var finalUrl = resp.url || url;
    noteId = extractNoteId(finalUrl);
    if (!noteId) {
      throw new MessageError("无法从短链中解析笔记 ID，最终地址: " + finalUrl);
    }
    url = finalUrl;
  }

  if (!noteId) {
    throw new MessageError("无法从链接中解析笔记 ID: " + url);
  }

  gopeed.logger.info("笔记 ID: " + noteId);

  // --- 2. 请求笔记页面 HTML ---
  var pageUrl = "https://www.xiaohongshu.com/explore/" + noteId;
  var resp2 = await fetch(pageUrl, { headers: headers });
  if (!resp2.ok) {
    throw new MessageError("请求笔记页面失败，状态码: " + resp2.status);
  }
  var html = await resp2.text();

  // --- 3. 提取 __INITIAL_STATE__ ---
  var state = extractInitialState(html);
  if (!state) {
    throw new MessageError("无法从页面中提取笔记数据 (.__INITIAL_STATE__)。可能需要设置 Cookie。");
  }

  // --- 4. 定位笔记详情 ---
  var noteData = findNoteData(state, noteId);
  if (!noteData) {
    throw new MessageError("无法定位笔记详情数据。笔记可能已被删除或设为私密。");
  }

  var title = noteData.title || noteData.desc || noteId;
  var noteType = noteData.type; // "normal"=图文, "video"=视频
  var files = [];

  gopeed.logger.info("笔记标题: " + title + ", 类型: " + noteType);

  // --- 5. 图文笔记：提取原图 ---
  if (noteType === "normal" || (!noteType && noteData.imageList)) {
    var imageList = noteData.imageList || [];
    for (var i = 0; i < imageList.length; i++) {
      var img = imageList[i];
      var imgUrl = "";
      // 优先用 infoList 里最大的图（urlDefault 或 url）
      if (img.urlDefault) {
        imgUrl = img.urlDefault;
      } else if (img.url) {
        imgUrl = img.url;
      } else if (img.infoList && img.infoList.length > 0) {
        // 按 size 降序取最大的
        var sorted = img.infoList.slice().sort(function (a, b) {
          return (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0);
        });
        imgUrl = sorted[0].url;
      }
      if (imgUrl) {
        // 确保是 https
        if (imgUrl.indexOf("//") === 0) imgUrl = "https:" + imgUrl;
        var ext = guessImageExt(imgUrl);
        var imgName = padNumber(i + 1, 2) + ext;
        files.push({
          name: imgName,
          req: { url: imgUrl }
        });
      }
    }
  }

  // --- 6. 视频笔记：提取视频流 ---
  if (noteType === "video" || (noteData.video && noteData.video.media)) {
    var videoUrl = extractVideoUrl(noteData);
    if (videoUrl) {
      if (videoUrl.indexOf("//") === 0) videoUrl = "https:" + videoUrl;
      files.push({
        name: "video.mp4",
        req: { url: videoUrl }
      });
    }
  }

  if (files.length === 0) {
    throw new MessageError("未找到可下载的媒体内容。笔记类型: " + (noteType || "未知"));
  }

  // 清理标题中的非法文件名字符
  var safeTitle = title.replace(/[\\/:*?"<>|]/g, "_").substring(0, 80);
  ctx.res = {
    name: safeTitle + "_" + noteId,
    files: files
  };

  gopeed.logger.info("解析完成，共 " + files.length + " 个文件");
});

// ========== 工具函数 ==========

function extractNoteId(url) {
  // /explore/{noteId} 或 /discovery/item/{noteId}
  var m = url.match(/xiaohongshu\.com\/(?:explore|discovery\/item)\/([a-fA-F0-9]{24})/);
  if (m) return m[1];
  // 也支持 /user/profile/{userId} 后面跟 noteId 的情况
  m = url.match(/xiaohongshu\.com\/explore\/([a-fA-F0-9]+)/);
  if (m) return m[1];
  return null;
}

function extractInitialState(html) {
  // 页面内嵌: window.__INITIAL_STATE__={...}
  var marker = "window.__INITIAL_STATE__=";
  var idx = html.indexOf(marker);
  if (idx === -1) {
    // 有时用 JSON.parse 包裹
    marker = "window.__INITIAL_STATE__ =";
    idx = html.indexOf(marker);
  }
  if (idx === -1) return null;

  var start = idx + marker.length;
  // 找到赋值结束位置：下一个 </script>
  var end = html.indexOf("</script>", start);
  if (end === -1) end = html.length;

  var raw = html.substring(start, end).trim();
  // 去掉末尾可能的分号
  if (raw.charAt(raw.length - 1) === ";") {
    raw = raw.substring(0, raw.length - 1);
  }

  // 小红书的 __INITIAL_STATE__ 中有些值是 undefined，JSON 不支持
  // 需要替换: undefined → null
  raw = raw.replace(/\bundefined\b/g, "null");

  try {
    return JSON.parse(raw);
  } catch (e) {
    gopeed.logger.warn("__INITIAL_STATE__ JSON 解析失败: " + e.message);
    // 尝试更宽松的提取
    return null;
  }
}

function findNoteData(state, noteId) {
  // 结构可能是 state.note.noteDetailMap[noteId].note
  // 或 state.noteData / state.note.detail 等，随版本变化
  try {
    // 路径 1: note.noteDetailMap
    if (state.note && state.note.noteDetailMap) {
      var detailMap = state.note.noteDetailMap;
      // key 可能就是 noteId，也可能带前缀
      if (detailMap[noteId]) {
        return detailMap[noteId].note || detailMap[noteId];
      }
      // 遍历找第一个
      var keys = Object.keys(detailMap);
      for (var i = 0; i < keys.length; i++) {
        var entry = detailMap[keys[i]];
        if (entry && entry.note) return entry.note;
        if (entry && (entry.imageList || entry.video)) return entry;
      }
    }

    // 路径 2: note.detail
    if (state.note && state.note.detail) {
      return state.note.detail;
    }

    // 路径 3: 顶层 noteData
    if (state.noteData) {
      return state.noteData;
    }

    // 路径 4: deepSearch 遍历
    return deepFindNote(state, noteId);
  } catch (e) {
    gopeed.logger.warn("查找笔记数据出错: " + e.message);
    return null;
  }
}

function deepFindNote(obj, noteId) {
  if (!obj || typeof obj !== "object") return null;
  // 如果当前对象有 imageList 或 video + id 匹配，可能就是目标
  if (obj.id === noteId && (obj.imageList || obj.video || obj.type)) {
    return obj;
  }
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
  // 从 video 字段提取最佳视频 URL
  try {
    var video = noteData.video;
    if (!video) return null;

    // 方式 1: media.stream（常见结构）
    if (video.media && video.media.stream) {
      var stream = video.media.stream;
      var h264 = stream.h264 || stream.H264 || [];
      if (h264.length > 0) {
        // 取码率最高的
        var best = h264[0];
        for (var i = 1; i < h264.length; i++) {
          if ((h264[i].videoBitrate || 0) > (best.videoBitrate || 0)) {
            best = h264[i];
          }
        }
        return best.masterUrl || best.url;
      }
      // 没有 h264，取任意可用流
      var allFormats = ["h265", "H265", "av1", "AV1"];
      for (var f = 0; f < allFormats.length; f++) {
        var fmt = stream[allFormats[f]];
        if (fmt && fmt.length > 0) {
          return fmt[0].masterUrl || fmt[0].url;
        }
      }
    }

    // 方式 2: video.url 直接是 URL
    if (video.url) return video.url;

    // 方式 3: consumer.originVideoKey 拼接
    if (video.consumer && video.consumer.originVideoKey) {
      return "https://sns-video-bd.xhscdn.com/" + video.consumer.originVideoKey;
    }

    // 方式 4: 遍历 media.streams
    if (video.media && video.media.streams) {
      var streams = video.media.streams;
      var streamKeys = Object.keys(streams);
      for (var s = 0; s < streamKeys.length; s++) {
        var arr = streams[streamKeys[s]];
        if (arr && arr.length > 0) {
          return arr[0].masterUrl || arr[0].url;
        }
      }
    }
  } catch (e) {
    gopeed.logger.warn("提取视频 URL 出错: " + e.message);
  }
  return null;
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
