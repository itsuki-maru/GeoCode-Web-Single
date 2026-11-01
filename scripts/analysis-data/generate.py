"""バックエンドに依存せず、再現可能な分析用テストデータ（Python 標準ライブラリを使用）。"""
import argparse
import json
from collections import Counter
from datetime import datetime, timedelta
from pathlib import Path
from uuid import UUID, uuid5

NAMESPACE = UUID('acddcb03-6a04-43e9-91f9-3858ef085f9d')
PROFILES = {'small': (8, 6, 4), 'basic': (24, 48, 12), 'normal': (120, 48, 30)}
START = datetime(2026, 10, 1)


def escape_markdown(text):
    return ''.join('\\' + c if c in '\\`*_{}[]<>()#+-.!|' else c for c in text)


def render_submission(fields, values, title):
    sections = []
    for field in fields:
        value = values.get(field['id'])
        if value is None:
            continue
        if field['type'] == 'checkbox':
            rendered = 'はい' if value else 'いいえ'
        elif field['type'] == 'number':
            rendered = json.dumps(value, ensure_ascii=False, allow_nan=False)
        else:
            rendered = escape_markdown(value.strip())
            if not rendered:
                continue
        sections.append(f"### {escape_markdown(field['label'])}\n\n{rendered}")
    return f'\n\n---\n\n## フォーム投稿: {escape_markdown(title)}\n\n' + '\n\n'.join(sections)


def generate(profile='basic', seed=20261020):
    rows, answers = [], []

    def uid(key):
        return str(uuid5(NAMESPACE, f'{profile}:{seed}:{key}'))

    def add(table, **values):
        rows.append({'table': table, 'values': values})

    def field(id, label, type, choices=None):
        return dict(id=id, label=label, type=type, required=False,
                    max_length=None, choices=choices or [])

    observation = [field('device_code', '機器コード', 'text'),
                   field('observed_date', '観測日', 'date'),
                   field('reading', '観測値', 'number'),
                   field('battery_level', '電池残量（%）', 'number'),
                   field('condition', '状態', 'select', ['正常', '注意', '異常']),
                   field('active', '稼働中', 'checkbox'), field('note', 'メモ', 'textarea')]
    registration = [field('record_name', '登録名', 'text'),
                    field('category', '分類', 'select', ['A', 'B', 'C']),
                    field('quantity', '数量', 'number'),
                    field('priority', '優先度', 'radio', ['低', '中', '高']),
                    field('available', '利用可能', 'checkbox'),
                    field('registered_date', '登録日', 'date'), field('note', 'メモ', 'textarea')]
    created = START.isoformat(sep=' ')
    niot, hours, nregistered = PROFILES[profile]
    for owner, count, times, registrations in [('main', niot, hours, nregistered), ('other', 1, 2, 0)]:
        user = uid(f'user:{owner}')
        add('user_model', id=user, username=f'analysis_{owner}_{profile}',
            password='__GENERATED__', create_at=created, is_superuser=False,
            failed_count=0, next_challenge_time=created, is_locked=False,
            is_private=False, is_basic_authed=False, is_basic_authed_at=created,
            totp_secret='', totp_temp_secret='')
        add('layer_model', id=uid(f'layer:{owner}:master'), user_id=user,
            layer_name='master', is_master=True, create_at=created, update_at=created)
        for region in range(3):
            add('layer_model', id=uid(f'layer:{owner}:{region}'), user_id=user,
                layer_name=f'分析テスト・地域{region + 1}', is_master=False,
                create_at=created, update_at=created)
        for kind, fields, title in [('observation', observation, '観測情報'),
                                     ('registration', registration, '登録情報')]:
            form = uid(f'form:{owner}:{kind}')
            schema = {'fields': fields}
            snapshot = dict(form_title=title, form_description='架空の分析テストデータ', form_schema=schema)
            source = {'id': form, 'version': 1}
            add('common_form_model', id=form, user_id=user, version=1, deleted=False,
                **snapshot, create_at=created, update_at=created)
            add('common_form_revision_model', form_id=form, version=1, form_schema=schema)
            for i in range(count if kind == 'observation' else registrations):
                target = 'shape' if kind == 'registration' and i % 2 else 'marker'
                key = f'{owner}:{kind}:{i}'
                target_id = uid(f'target:{key}')
                region = i % 3
                lat, lng = [(35.68, 139.76), (35.45, 139.64), (35.88, 139.63)][region]
                # 各地域内で重なる点と、より広い範囲に分布する点を含める。
                offset = 0 if i < 6 else ((i // 3 + seed % 11) % 20) * 0.001
                lat, lng = round(lat + offset, 6), round(lng + offset, 6)
                layer = uid(f'layer:{owner}:{region}')
                name = f'テスト・{title}-{i + 1:03}'
                if target == 'marker':
                    add('marker_info_model', id=target_id, user_id=user, layer_id=layer,
                        marker_name=name, latitude=lat, longitude=lng, detail='架空の分析テスト対象',
                        create_at=created, update_at=created)
                else:
                    coordinates = [[lng, lat], [lng + .002, lat], [lng + .002, lat + .002],
                                   [lng, lat + .002], [lng, lat]]
                    geometry = {'type': 'Feature', 'properties': {},
                                'geometry': {'type': 'Polygon', 'coordinates': [coordinates]}}
                    add('shape_model', id=target_id, user_id=user, layer_id=layer, name=name,
                        shape_type='polygon', geojson=geometry, created_at=created, updated_at=created)
                target_values = rows[-1]['values']
                total = times if kind == 'observation' else 3
                latest_at = (START + timedelta(hours=total - 1)).isoformat(sep=' ')
                add(f'{target}_form_config_model', **{f'{target}_id': target_id},
                    public_id=uid(f'public:{key}'), enabled=True, **snapshot, password_hash=None,
                    source_form=source, create_at=created, update_at=latest_at)
                markdown_parts = []
                for t in range(total):
                    at = (START + timedelta(hours=t)).isoformat(sep=' ')
                    if kind == 'observation':
                        value = region * 40 + (t % 6 - 2) * 2.5
                        condition = '正常' if value < 30 else '注意' if value < 70 else '異常'
                        values = dict(device_code=f'TEST-{i + 1:03}', observed_date=at[:10],
                                      reading=value, battery_level=max(0, 100 - t * 2),
                                      condition=condition, active=(i + t) % 2 == 0,
                                      note=f'地域{region + 1}\n観測 {t + 1}')
                    else:
                        values = dict(record_name=name, category=['A', 'B', 'C'][region],
                                      quantity=(i + t) * .5, priority=['低', '中', '高'][region],
                                      available=(i + t) % 2 == 0, registered_date=at[:10],
                                      note='架空の登録情報\n継続確認')
                    answer_id = uid(f'answer:{key}:{t}')
                    markdown = render_submission(fields, values, title)
                    markdown_parts.append(markdown)
                    add(f'{target}_form_submission_model', id=answer_id,
                        **{f'{target}_id': target_id}, submitted_values=values,
                        # 検索・分析では、この表示用テキストに依存しない設計とする。
                        rendered_markdown=markdown,
                        source_form=source, form_snapshot=snapshot, create_at=at)
                    answers.append(dict(id=answer_id, owner=owner, target_type=target,
                                        target_id=target_id, kind=kind, at=at, values=values))
                if target == 'marker':
                    target_values['detail'] += ''.join(markdown_parts)
                    target_values['update_at'] = latest_at
                else:
                    memo = ''.join(markdown_parts)
                    if len(memo) > 10_000:
                        raise ValueError('図形メモの上限10000文字を超えています')
                    target_values['geojson']['properties']['memo'] = memo
                    target_values['updated_at'] = latest_at

    def expected(owner, mode, kind=None, condition=None):
        selected = [a for a in answers if a['owner'] == owner and (kind is None or a['kind'] == kind)]
        if mode == 'latest':
            groups = {}
            for a in selected:
                key = (a['target_type'], a['target_id'], a['kind'])
                if key not in groups or (a['at'], a['id']) > (groups[key]['at'], groups[key]['id']):
                    groups[key] = a
            selected = list(groups.values())
        if condition:
            selected = [a for a in selected if condition(a['values'])]
        return dict(answers=len(selected), targets=len({(a['target_type'], a['target_id']) for a in selected}))

    checks = []
    for owner in ['main', 'other']:
        for mode in ['history', 'latest']:
            base = dict(mode=mode, as_of='2026-10-10T00:00:00Z', conditions=[])
            checks.append(dict(name=f'{owner}-{mode}-all', owner=uid(f'user:{owner}'),
                               query=base, expected=expected(owner, mode)))
            if owner == 'main':
                for state in ['正常', '注意', '異常']:
                    query = dict(base, common_form_id=uid(f'form:{owner}:observation'), conditions=[
                        dict(field_id='condition', field_type='select', op='in', value=[state])])
                    checks.append(dict(name=f'{mode}-{state}', owner=uid(f'user:{owner}'), query=query,
                                       expected=expected(owner, mode, 'observation', lambda v: v['condition'] == state)))
                for label, condition, predicate in [
                    ('zero', dict(field_id='reading', field_type='number', op='eq', value=0), lambda v: v['reading'] == 0),
                    ('false', dict(field_id='active', field_type='checkbox', op='eq', value=False), lambda v: v['active'] is False),
                ]:
                    checks.append(dict(name=f'{mode}-{label}', owner=uid(f'user:{owner}'),
                                       query=dict(base, common_form_id=uid(f'form:{owner}:observation'), conditions=[condition]),
                                       expected=expected(owner, mode, 'observation', predicate)))
    return dict(format_version=2, profile=profile, seed=seed, rows=rows, checks=checks,
                counts=dict(Counter(r['table'] for r in rows)))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--profile', choices=PROFILES, default='basic')
    parser.add_argument('--seed', type=int, default=20261020)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    data = generate(args.profile, args.seed)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'profile': args.profile, 'checks': len(data['checks']), 'counts': data['counts']}, ensure_ascii=False))


if __name__ == '__main__':
    main()
