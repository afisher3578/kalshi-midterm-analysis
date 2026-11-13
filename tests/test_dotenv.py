""".env support and the key leak test for every Media Cloud path (MC1).

A fake key (built at runtime from uuid4, so no literal is in the repo) is put in a temporary .env. The CLI loads
it, then runs the pipeline, the collections lookup, the audit, a 401 error path and the precision report, all on
fake HTTP whose responses echo the request headers back (the worst case). Afterwards every file written, the
captured stdout and stderr, and the repo tree must not contain the key.
"""
import json
import os
import uuid

from raceattn import envfile
from raceattn import mediacloud as mc
from tests.conftest import HERE, ROOT
from tests.fakes import Resp
from tests.test_leaks import grep_tree
from tests.test_mediacloud import patch_session


def test_parse_and_no_override(tmp_path):
    p = tmp_path / ".env"
    p.write_text("# comment\nexport A_ONE=1\nB_TWO = 'two words'\nC_THREE=\"x#y\"\nD_FOUR=val # note\nEMPTY=\n"
                 "not a line\nKEEP=from-file\n")
    env = {"KEEP": "from-shell"}
    loaded = envfile.load_env(str(p), env)
    assert env == {"KEEP": "from-shell", "A_ONE": "1", "B_TWO": "two words", "C_THREE": "x#y", "D_FOUR": "val"}
    assert sorted(loaded) == ["A_ONE", "B_TWO", "C_THREE", "D_FOUR"]
    assert envfile.load_env(str(tmp_path / "missing"), {}) == []


def test_cli_loads_dotenv_without_overriding(tmp_path, monkeypatch, capsys):
    from raceattn.cli import main

    secret = "mc-" + uuid.uuid4().hex
    p = tmp_path / ".env"
    p.write_text("MEDIACLOUD_API_KEY=%s\n" % secret)
    monkeypatch.setattr(envfile, "ENV_PATH", str(p))
    monkeypatch.setenv("MEDIACLOUD_API_KEY", "already-set")
    main(["validate", "--race", "tx-senate-2026"])
    assert os.environ["MEDIACLOUD_API_KEY"] == "already-set"
    assert secret not in capsys.readouterr().err


def test_dotenv_key_never_leaks(tmp_path, monkeypatch, capsys):
    from raceattn.cli import main

    secret = "mc-" + uuid.uuid4().hex
    envp = tmp_path / ".env"
    envp.write_text("# test .env\nMEDIACLOUD_API_KEY=%s\n" % secret)
    monkeypatch.setattr(envfile, "ENV_PATH", str(envp))
    monkeypatch.setenv("MEDIACLOUD_API_KEY", "placeholder")  # so monkeypatch removes what the CLI sets
    monkeypatch.delenv("MEDIACLOUD_API_KEY")
    work = tmp_path / "work"
    raw, out, audit = work / "raw", work / "out", work / "audit" / "tuning.csv"
    stories = json.load(open(os.path.join(HERE, "fixtures", "mediacloud", "story_list.synthetic.json")))["pages"]
    fail = {"on": False}

    def route(method, url, params, headers, body):
        echo = "echo %s %s" % (json.dumps(headers), json.dumps(params))
        if fail["on"]:
            return Resp(401, {"detail": "Invalid token. " + echo})
        if url == mc.COUNT_URL:
            return Resp(200, {"count_over_time": {"counts": [
                {"date": "2026-09-%02d 00:00:00" % d, "count": 5, "total_count": 100, "ratio": 0.05, "note": echo}
                for d in range(1, 31)]}})
        if url == mc.COLLECTIONS_URL:
            return Resp(200, {"count": 1, "next": None, "results": [{"id": 1, "name": "Synthetic " + echo,
                                                                     "source_count": 2}]})
        if url == mc.STORY_LIST_URL:
            page = dict(stories[0], pagination_token=None)
            page["stories"] = [dict(s, title=s["title"] + " " + echo) for s in page["stories"]]
            return Resp(200, page)
        raise AssertionError(url)

    sessions = patch_session(monkeypatch, route)
    codes = [
        main(["run", "--race", "tx-senate-2026", "--sources", "news_mediacloud", "--raw-dir", str(raw),
              "--out-dir", str(out), "--mediacloud-pace", "0"]),
        main(["mediacloud", "collections", "--state", "TX", "--raw-dir", str(raw), "--pace", "0"]),
        main(["mediacloud", "audit", "--race", "tx-senate-2026", "--phase", "tuning", "--n", "5", "--out", str(audit),
              "--raw-dir", str(raw), "--pace", "0"]),
        main(["mediacloud", "precision", str(audit)]),
    ]
    fail["on"] = True
    codes.append(main(["mediacloud", "collections", "--name", "Other", "--raw-dir", str(raw), "--refresh",
                       "--pace", "0"]))
    codes.append(main(["run", "--race", "tx-senate-2026", "--sources", "news_mediacloud", "--raw-dir",
                       str(work / "raw_err"), "--out-dir", str(work / "out_err"), "--mediacloud-pace", "0"]))
    assert codes == [0, 0, 0, 0, 2, 2]
    sent = [r for s in sessions for r in s.requests]
    assert len(sent) == 16 + 1 + 4 + 1 + 1 and all(r["headers"]["Authorization"] == "Token " + secret for r in sent)
    cap = capsys.readouterr()
    assert "HTTP 401" in cap.err and "loaded from .env: MEDIACLOUD_API_KEY (values not shown)" in cap.err
    assert secret not in cap.out and secret not in cap.err
    assert os.path.isfile(out / "tx-senate-2026.json") and os.path.isfile(audit)
    assert grep_tree(str(work), [secret]) == []
    assert grep_tree(ROOT, [secret]) == []
