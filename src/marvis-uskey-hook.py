"""
Marvis uskey 桥 —— 在 MarvisAgent 进程内按需生成合法请求头。

由 DSH 的 dsh-providers-hub 插件安装（写入 `_internal/sitecustomize.py`）。
Python 启动时会自动 import sitecustomize（`sys.flags.no_site == 0`），
故本文件是**唯一的**注入点，不需要改 Marvis 任何原始文件。

工作方式（纯本地文件 RPC，无网络，不改变 agent 的任何业务行为）：
  DSH 写入  <RPC_DIR>/req-<id>.json   {conv_id, resp_id, agent_tag, scene, model}
  本钩子轮询目录，调用 agent 自己的 LLMHeaderService.build() 生成请求头
  写回     <RPC_DIR>/resp-<id>.json  {ok, headers} 或 {ok: false, error}

约束：uskey 有效期实测约 60 秒，故必须**按需实时生成**，不能缓存。

卸载：删除本文件并重启 Marvis 即可，无其他残留。
"""
import json
import os
import sys
import threading
import time
import traceback

# {{RPC_DIR}} / {{LOG_PATH}} 由安装器在写入时替换为绝对路径。
RPC_DIR = r"{{RPC_DIR}}"
LOG = r"{{LOG_PATH}}"
LOCK = threading.Lock()

# 鉴权头缺失时 uskey 为空，服务端会以 4100403（未登录）拒绝，故提前给出可读日志。
_MARKER = "uskey-rpc"


def _log(msg):
    try:
        with LOCK:
            with open(LOG, "a", encoding="utf-8") as fh:
                fh.write(f"{time.strftime('%H:%M:%S')} {msg}\n")
                fh.flush()
    except Exception:
        # 日志失败绝不能影响 agent 主流程
        pass


def _find_service():
    """在 gc 里找活的 LLMHeaderService 实例（agent 自己创建的那个）。"""
    import gc

    for obj in gc.get_objects():
        try:
            if type(obj).__name__ == "LLMHeaderService":
                return obj
        except Exception:
            continue
    return None


def _build_headers(conv_id, resp_id, agent_tag, scene, model):
    """调用 agent 自己的 build()，返回真实的请求头字典。"""
    mod = sys.modules.get("ai_agent.services.llm_headers")
    if mod is None:
        raise RuntimeError("llm_headers 模块未加载（agent 启动未完成？）")

    svc = _find_service()
    if svc is None:
        raise RuntimeError("找不到 LLMHeaderService 实例")

    Ctx = getattr(mod, "LLMHeaderBuildContext")
    Kind = getattr(mod, "LLMInvocationKind", None)

    kwargs = {
        "auth_store": getattr(svc, "_auth_store", None),
        "agent_name": agent_tag,
        "conversation_id": conv_id,
        "response_id": resp_id,
        "scene": scene,
    }
    if model:
        kwargs["model"] = model
    if Kind is not None:
        try:
            kwargs["invocation_kind"] = Kind.AGENT_USER_TURN
        except Exception:
            pass

    ctx = Ctx(**kwargs)
    headers = svc.build(ctx)
    if headers is None:
        raise RuntimeError("build() 返回 None（可能未登录）")
    return dict(headers)


def _handle(req_path):
    rid = os.path.basename(req_path)[4:-5]
    resp_path = os.path.join(RPC_DIR, f"resp-{rid}.json")
    try:
        with open(req_path, "r", encoding="utf-8") as fh:
            req = json.load(fh)
        _log(f"req {rid} conv={req.get('conv_id')}")

        headers = _build_headers(
            req.get("conv_id") or "",
            req.get("resp_id") or ("resp_" + rid.replace("-", "")),
            req.get("agent_tag") or "agent_chat",
            req.get("scene") or "agent_chat",
            req.get("model"),
        )
        out = {"ok": True, "headers": headers}
        # 记录 uskey 形状，便于诊断（正常恒为 524 / 前缀 CsDVDCER）
        try:
            ext = json.loads(headers.get("Ual-Access-MarvisExt", "{}"))
            _log(f"  ok uskey={len(ext.get('uskey',''))}chars prefix={ext.get('uskey','')[:8]}")
        except Exception:
            pass
    except Exception:
        out = {"ok": False, "error": traceback.format_exc()[-1500:]}
        _log(f"  ERR {rid}: {traceback.format_exc()[-300:]}")

    try:
        tmp = resp_path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(out, fh)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, resp_path)
    except Exception:
        _log(f"  write-fail {rid}")
    finally:
        try:
            os.remove(req_path)
        except Exception:
            pass


def _loop():
    # 等 agent 把 ai_agent.services.llm_headers 加载完再把服务实例建出来。
    time.sleep(6)
    _log(f"bridge start pid={os.getpid()}")
    seen = set()
    while True:
        try:
            if os.path.isdir(RPC_DIR):
                for fn in os.listdir(RPC_DIR):
                    if not (fn.startswith("req-") and fn.endswith(".json")):
                        continue
                    if fn in seen:
                        continue
                    seen.add(fn)
                    _handle(os.path.join(RPC_DIR, fn))
            # 防止 seen 无限增长
            if len(seen) > 500:
                seen.clear()
        except Exception:
            _log("loop err " + traceback.format_exc()[-200:])
        time.sleep(0.15)


def _install():
    _log(f"hook loaded pid={os.getpid()}")
    try:
        os.makedirs(RPC_DIR, exist_ok=True)
    except Exception:
        pass
    threading.Thread(target=_loop, daemon=True).start()


try:
    _install()
except Exception:
    # 钩子自身失败必须静默：它寄生在 agent 启动路径上。
    pass