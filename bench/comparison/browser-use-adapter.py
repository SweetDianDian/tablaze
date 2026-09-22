"""Pinned Browser Use public Agent adapter. JSON stdin/stdout; logs stay on stderr."""
import asyncio
import contextlib
import importlib.metadata
import json
import os
from pathlib import Path
import re
import sys
import time
from tempfile import TemporaryDirectory
from urllib.parse import urlsplit

PIN = "d8110c5ff87ccba887aaa726cdb780f2f84bef8d"
VERSION = "0.13.10"
os.environ["ANONYMIZED_TELEMETRY"] = "false"
os.environ["BROWSER_USE_CLOUD_SYNC"] = "false"
os.environ["BROWSER_USE_LOGGING_LEVEL"] = "error"


def pinned_source(direct):
    """Accept exact Git source or hashed archives from the official repository."""
    if direct.get("vcs_info", {}).get("commit_id") == PIN:
        return {"kind": "git", "commit": PIN}
    url = direct.get("url", "")
    parsed = urlsplit(url)
    allowed_paths = {
        "github.com": {f"/browser-use/browser-use/archive/{PIN}.zip", f"/browser-use/browser-use/archive/{PIN}.tar.gz"},
        "codeload.github.com": {f"/browser-use/browser-use/zip/{PIN}", f"/browser-use/browser-use/tar.gz/{PIN}"},
    }
    sha = direct.get("archive_info", {}).get("hashes", {}).get("sha256", "")
    if (parsed.scheme == "https" and parsed.netloc in allowed_paths
            and parsed.path in allowed_paths[parsed.netloc] and not parsed.query and not parsed.fragment
            and isinstance(sha, str) and re.fullmatch(r"[a-fA-F0-9]{64}", sha)):
        return {"kind": "official_archive", "commit": PIN, "url": url, "sha256": sha.lower()}
    return None


def preflight():
    if sys.version_info < (3, 11):
        return {"status": "not_run", "reason": "Browser Use requires Python >= 3.11; pass --python for a prepared Python 3.12 environment"}
    try:
        distribution = importlib.metadata.distribution("browser-use")
    except importlib.metadata.PackageNotFoundError:
        return {"status": "not_run", "reason": "browser-use dependency is missing"}
    try:
        direct = json.loads(distribution.read_text("direct_url.json") or "{}")
        source = pinned_source(direct)
    except (TypeError, ValueError, AttributeError):
        source = None
    if distribution.version != VERSION or source is None:
        return {"status": "not_run", "reason": "Install browser-use from the exact git commit or hashed official HTTPS archive in baseline.json", "version": distribution.version}
    try:
        with contextlib.redirect_stdout(sys.stderr):
            from browser_use import Agent, Browser, ChatOpenAI  # noqa: F401
    except Exception as error:
        return {"status": "not_run", "reason": "Pinned dependency cannot be imported", "error_type": type(error).__name__}
    return {"status": "ready", "version": distribution.version, "commit": PIN, "source": source}


async def execute(config):
    from browser_use import Agent, Browser, ChatOpenAI
    started = time.monotonic()
    deadline_at = config.get("deadlineAtMs", time.time() * 1000 + config.get("timeoutMs", 120000))
    work = Path(config["workDirectory"])
    downloads = work / "downloads"
    downloads.mkdir(parents=True, exist_ok=True)
    progress_path = work / "adapter-progress.json"
    history_path = work / "browser-use-history.json"
    events = []
    phase = "setup"
    observed_done = False
    observed_success = None
    done_at = None
    returned = False
    timed_out = False
    timeout_phase = None
    interrupted_error = None
    failure = None
    failure_phase = None
    history_error = None
    browser_version = None
    agent = None
    cleanup = {"status": "not_started", "elapsedMs": None}
    judge_calls = []
    observed_artifact_paths = set()
    cleanup_seconds = max(0.01, min(config.get("cleanupTimeoutMs", 5000), 10000) / 1000)

    def elapsed():
        return round((time.monotonic() - started) * 1000, 3)

    def event(kind, **details):
        events.append({"type": kind, "atMs": elapsed(), **details})

    def judge_usage():
        # A missing response never means zero tokens. This is a subset of the
        # gateway totals, not an additional cost to add to them.
        def total(field):
            values = [call.get("usage", {}).get(field) if call.get("usage") else None for call in judge_calls]
            return sum(values) if all(type(value) is int and value >= 0 for value in values) else None
        return {"inputTokens": total("prompt_tokens"), "outputTokens": total("completion_tokens"),
                "cachedTokens": total("prompt_cached_tokens"), "totalTokens": total("total_tokens"),
                "source": "public ChatInvokeCompletion.usage; subset of gateway totals"}

    def snapshot():
        nonlocal history_error
        observed_artifact_paths.update(browser.downloaded_files)
        history = agent.history if agent is not None else None
        portable = None
        if history is not None:
            try:
                agent.save_history(str(history_path))
                if history_path.stat().st_size <= 16 * 1024 * 1024:
                    portable = json.loads(history_path.read_text())
                else:
                    history_error = "history_exceeds_portable_trace_limit"
            except Exception as error:
                history_error = type(error).__name__
        completion = {
            "agentDoneObserved": observed_done, "agentSuccessObserved": observed_success,
            "agentDoneAtMs": done_at, "agentDoneSource": "public Agent.run on_step_end / AgentHistoryList",
            "agentRunReturned": returned, "timedOut": timed_out, "timeoutPhase": timeout_phase,
            "errorPhase": failure_phase,
            "phase": phase, "adapterElapsedMs": elapsed(), "cleanup": dict(cleanup),
            "browserUseJudge": config.get("browserUseJudge", True),
            "judgeInstrumentation": "explicit judge_llm public ainvoke; excludes judge prompt construction and other finalization",
            "judgeModelCalls": len(judge_calls), "judgeUsage": judge_usage(),
            "postDonePhaseMeaning": "inferred from done observed before Agent.run returned; not attributed solely to judge",
        }
        status = "limit_reached" if timed_out else "failed" if failure else "succeeded" if returned and history is not None and history.is_successful() is True else "failed"
        result = {
            "agentStatus": status, "claimedSuccess": observed_success is True,
            "steps": history.number_of_steps() if history is not None else None,
            "toolCalls": len(history.action_results()) if history is not None else None,
            "browserVersion": browser_version, "toolTimeMs": None,
            "artifactPaths": sorted(observed_artifact_paths), "completion": completion,
            "trace": {"history_path": str(history_path), "history": portable,
                      "summary": history.final_result() if history is not None else None,
                      "phaseEvents": list(events), "judgeCalls": list(judge_calls), "completion": completion,
                      "error_type": failure, "history_error": history_error},
        }
        temporary = progress_path.with_suffix(".tmp")
        temporary.write_text(json.dumps(result))
        temporary.chmod(0o600)
        temporary.replace(progress_path)
        return result

    async def on_step_end(current):
        nonlocal phase, observed_done, observed_success, done_at
        history = current.history
        event("step_end", steps=history.number_of_steps(), toolCalls=len(history.action_results()))
        if history.is_done():
            observed_done = True
            observed_success = history.is_successful()
            done_at = done_at if done_at is not None else elapsed()
            phase = "post_done_processing"
            event("agent_done_observed", success=observed_success)
        snapshot()

    class MeasuredJudge(ChatOpenAI):
        async def ainvoke(self, *args, **kwargs):
            nonlocal phase, interrupted_error
            phase = "judge_model"
            measured = {"startedAtMs": elapsed(), "endedAtMs": None, "outcome": "pending", "usage": None}
            judge_calls.append(measured)
            event("judge_model_start")
            snapshot()
            try:
                response = await super().ainvoke(*args, **kwargs)
                usage = getattr(response, "usage", None)
                if usage is not None:
                    measured["usage"] = {field: getattr(usage, field, None) for field in (
                        "prompt_tokens", "completion_tokens", "prompt_cached_tokens", "total_tokens",
                        "prompt_cache_creation_tokens", "prompt_cache_creation_5m_tokens",
                        "prompt_cache_creation_1h_tokens", "prompt_image_tokens",
                    )}
                measured["outcome"] = "returned"
                event("judge_model_end", outcome="returned")
                return response
            except BaseException as error:
                interrupted_error = (error, phase)
                measured["outcome"] = "interrupted"
                measured["error_type"] = type(error).__name__
                event("judge_model_end", outcome="interrupted", error_type=type(error).__name__)
                raise
            finally:
                measured["endedAtMs"] = elapsed()
                phase = "post_done_processing" if observed_done else "agent_run"
                snapshot()

    browser = Browser(
        headless=True, executable_path=config["executablePath"], user_data_dir=str(work / "profile"),
        viewport={"width": 1280, "height": 800}, downloads_path=str(downloads),
        accept_downloads=True, use_cloud=False, keep_alive=True,
        enable_default_extensions=False,
    )
    llm_options = dict(
        model=config["model"], api_key="local-benchmark-gateway",
        base_url=config["gatewayEndpoint"].removesuffix("/chat/completions"),
        temperature=config.get("temperature", 0), frequency_penalty=None,
        max_retries=0, max_completion_tokens=config.get("maxOutputTokens", 4096),
    )
    llm = ChatOpenAI(**llm_options)
    agent = Agent(
        task=config["prompt"], llm=llm, judge_llm=MeasuredJudge(**llm_options),
        use_judge=config.get("browserUseJudge", True), browser=browser, use_vision=True,
        available_file_paths=[config["uploadPath"]] if config.get("uploadPath") else [],
        file_system_path=str(work / "agent-files"), calculate_cost=False,
        enable_signal_handler=False,
    )
    async def workflow():
        nonlocal phase, browser_version, returned, observed_done, observed_success, done_at
        phase = "browser_start"
        event("browser_start")
        await browser.start()
        version = await browser.cdp_client.send.Browser.getVersion()
        browser_version = version.get("product", "").removeprefix("Chrome/") or None
        phase = "agent_run"
        event("agent_run_start")
        history = await agent.run(max_steps=config.get("maxSteps", 40), on_step_end=on_step_end)
        returned = True
        if history.is_done():
            observed_done, observed_success = True, history.is_successful()
            done_at = done_at if done_at is not None else elapsed()
        phase = "agent_returned"
        event("agent_run_returned", success=history.is_successful())

    async def bounded_stop(task, seconds):
        task.cancel()
        done, _ = await asyncio.wait({task}, timeout=seconds)
        if task in done:
            try:
                task.result()
            except BaseException:
                pass
        return task in done

    snapshot()
    task = asyncio.create_task(workflow())
    try:
        done, _ = await asyncio.wait({task}, timeout=max(0, (deadline_at - time.time() * 1000) / 1000))
        if task not in done:
            timed_out, timeout_phase = True, phase
            event("deadline_reached", phase=timeout_phase)
            snapshot()
            settled = await bounded_stop(task, 2)
            event("agent_cancelled", settled=settled)
        else:
            task.result()
    except BaseException as error:
        failure = type(error).__name__
        failure_phase = interrupted_error[1] if interrupted_error and interrupted_error[0] is error else phase
        event("agent_run_error", error_type=failure, phase=failure_phase)
        if not task.done():
            await bounded_stop(task, 2)
    finally:
        # BrowserSession.kill() resets downloaded_files. Preserve only paths
        # actually reported before teardown; the independent judge still reads
        # their files and hashes their contents from our explicit downloads dir.
        observed_artifact_paths.update(browser.downloaded_files)
        phase = "owned_cleanup"
        event("cleanup_start")
        cleanup_start = elapsed()
        cleanup_task = asyncio.create_task(browser.kill())
        done, _ = await asyncio.wait({cleanup_task}, timeout=cleanup_seconds)
        if cleanup_task not in done:
            cleanup["status"] = "timeout"
            await bounded_stop(cleanup_task, 0.1)
        else:
            try:
                cleanup_task.result()
                cleanup["status"] = "completed"
            except BaseException as error:
                cleanup["status"], cleanup["error_type"] = "failed", type(error).__name__
        cleanup["elapsedMs"] = round(elapsed() - cleanup_start, 3)
        phase = "adapter_finished"
        event("cleanup_end", **cleanup)
    return snapshot()


def run_main():
    check = preflight()
    if "--preflight" in sys.argv or check["status"] != "ready":
        print(json.dumps(check)); return
    config = json.load(sys.stdin)
    try:
        with contextlib.redirect_stdout(sys.stderr):
            # asyncio.run waits indefinitely for cancellation-resistant tasks
            # during shutdown. Bound that grace period; the parent supervises
            # this entire owned process group as a final containment boundary.
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            try:
                result = loop.run_until_complete(execute(config))
                pending = asyncio.all_tasks(loop)
                for task in pending:
                    task.cancel()
                if pending:
                    _, remaining = loop.run_until_complete(asyncio.wait(pending, timeout=2))
                    if remaining:
                        result["completion"]["shutdownPendingTasks"] = len(remaining)
            finally:
                loop.close()
    except Exception as error:
        result = {"agentStatus": "failed", "claimedSuccess": False, "steps": None, "toolCalls": None,
                  "artifactPaths": [], "trace": {"error_type": type(error).__name__}}
    print(json.dumps(result), flush=True)
    completion = result.get("completion", {})
    if completion.get("cleanup", {}).get("status") not in (None, "completed") or completion.get("shutdownPendingTasks"):
        # Nonzero completion makes the parent kill any surviving owned process
        # group while retaining this JSON/progress evidence instead of losing it.
        raise SystemExit(3)


def main():
    # The framework initializes configuration even in dependency preflight.
    # Always isolate that initialization from the user's settings and profiles.
    with TemporaryDirectory(prefix="tablaze-browser-use-config-") as directory:
        os.environ["BROWSER_USE_CONFIG_DIR"] = directory
        run_main()


if __name__ == "__main__":
    main()
