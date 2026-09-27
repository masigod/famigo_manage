"""합성 게이트 — 테스트 전용. 실제 게이트는 ~/famigo_campaign/briefs/tools/lark_store.py 다."""


def export_for_slack(payload):
    # 실제 게이트처럼 부분일치 + 중첩 재귀로 민감 키를 지운다.
    def walk(v):
        if isinstance(v, dict):
            return {k: walk(x) for k, x in v.items() if "amount" not in k.lower()}
        if isinstance(v, list):
            return [walk(x) for x in v]
        return v
    return walk(payload)
