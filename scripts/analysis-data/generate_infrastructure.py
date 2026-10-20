"""施設24点・管路36本の架空データ。両DB共通の独立検証セット。"""
import argparse
import json
import math
from collections import Counter
from datetime import date
from pathlib import Path
from uuid import uuid5
from generate import NAMESPACE, render_submission

MATERIALS = ['GX', '塩ビ', '配ポリ']


def length_metres(coordinates):
    """WGS84座標を球面近似した線分長（表示用のm、計測精度の保証はしない）。"""
    result = 0.0
    for (x1, y1), (x2, y2) in zip(coordinates, coordinates[1:]):
        lat1, lat2 = math.radians(y1), math.radians(y2)
        dlat, dlon = lat2-lat1, math.radians(x2-x1)
        a = math.sin(dlat/2)**2 + math.cos(lat1)*math.cos(lat2)*math.sin(dlon/2)**2
        result += 6371008.8 * 2 * math.atan2(math.sqrt(a), math.sqrt(max(0, 1-a)))
    return round(result, 2)


def generate(seed=20261020):
    profile = 'infrastructure'
    uid = lambda key: str(uuid5(NAMESPACE, f'{profile}:{seed}:{key}'))
    rows, answers = [], []
    created, updated = '2026-10-01 00:00:00', '2026-10-02 00:00:00'
    owner = uid('user:main')

    def add(table, **values):
        rows.append(dict(table=table, values=values))
        return values

    def field(id, label, kind, choices=None):
        return dict(id=id, label=label, type=kind, required=True, max_length=None, choices=choices or [])

    add('user_model', id=owner, username='analysis_main_infrastructure', password='__GENERATED__',
        create_at=created, is_superuser=False, failed_count=0, next_challenge_time=created,
        is_locked=False, is_private=False, is_basic_authed=False, is_basic_authed_at=created,
        totp_secret='', totp_temp_secret='')
    add('layer_model', id=uid('master'), user_id=owner, layer_name='master', is_master=True,
        create_at=created, update_at=created)
    for region in range(3):
        for kind, name in [('facility', '施設'), ('pipe', '管路')]:
            add('layer_model', id=uid(f'layer:{kind}:{region}'), user_id=owner,
                layer_name=f'地域{region+1}・{name}', is_master=False, create_at=created, update_at=created)
    definitions = {
        'facility': ('施設情報', [field('facility_name', '施設名', 'text'),
            field('construction_date', '建設年月日', 'date'), field('service_life', '耐用年数（年）', 'number')]),
        'pipe': ('管路情報', [field('pipe_name', '管路名', 'text'),
            field('pipe_length', '管路延長（m）', 'number'), field('material', '材質', 'select', MATERIALS)])
    }
    for kind, (title, fields) in definitions.items():
        schema = dict(fields=fields)
        add('common_form_model', id=uid(f'form:{kind}'), user_id=owner, version=1, deleted=False,
            form_title=title, form_description='架空の分析検証用データです。実施設・実管路ではありません。',
            form_schema=schema, create_at=created, update_at=created)
        add('common_form_revision_model', form_id=uid(f'form:{kind}'), version=1, form_schema=schema)

    def attach(kind, region, index, target, values, histories):
        title, fields = definitions[kind]
        source = dict(id=uid(f'form:{kind}'), version=1)
        snapshot = dict(form_title=title, form_description='架空の分析検証用データです。実施設・実管路ではありません。',
                        form_schema=dict(fields=fields))
        add(f'{target}_form_config_model', **{f'{target}_id': values['id']},
            public_id=uid(f'public:{kind}:{region}:{index}'), enabled=True, **snapshot,
            password_hash=None, source_form=source, create_at=created, update_at=updated)
        parts = []
        for version, (at, submitted) in enumerate(zip([created, updated], histories)):
            markdown = render_submission(fields, submitted, title)
            parts.append(markdown)
            add(f'{target}_form_submission_model', id=uid(f'answer:{kind}:{region}:{index}:{version}'),
                **{f'{target}_id': values['id']}, submitted_values=submitted, rendered_markdown=markdown,
                create_at=at, source_form=source, form_snapshot=snapshot)
            answers.append(dict(kind=kind, target=values['id'], values=submitted, at=at))
        if target == 'marker':
            values['detail'] += ''.join(parts)
        else:
            values['geojson']['properties']['memo'] = ''.join(parts)

    # 2行×4列の施設点を各地域に配置。管路の端点を必ず施設点と一致させる。
    for region, (lat, lng) in enumerate([(35.68, 139.76), (35.45, 139.64), (35.88, 139.63)]):
        positions = [[round(lng+col*.0015, 7), round(lat+row*.0015, 7)] for row in range(2) for col in range(4)]
        for i, (x, y) in enumerate(positions):
            index = region*8+i
            name = f'検証施設・地域{region+1}-{i+1:02}'
            construction = date([1975,1985,1995,2005,2015,2020,2023,2025][i], i+1, 1).isoformat()
            life = [30,40,50,60][i%4]
            values = add('marker_info_model', id=uid(f'facility:{region}:{i}'), user_id=owner,
                layer_id=uid(f'layer:facility:{region}'), marker_name=name, latitude=y, longitude=x,
                detail='架空の施設情報。耐用年数は分析用の仮定値で、実際の基準ではありません。',
                create_at=created, update_at=updated)
            original = dict(facility_name=name, construction_date=construction, service_life=life)
            current = dict(original, service_life=life+(10 if index%3==0 else 0))
            attach('facility',region,i,'marker',values,[original,current])
        edges = [(r*4+c,r*4+c+1) for r in range(2) for c in range(3)] + [(c,c+4) for c in range(4)] + [(0,5),(2,7)]
        for i,(start,end) in enumerate(edges):
            coordinates = [positions[start],positions[end]]
            length = length_metres(coordinates)
            material = MATERIALS[i%3]
            current_material = MATERIALS[(i%3+1)%3] if i%4==0 else material
            name = f'検証管路・地域{region+1}-{i+1:02}'
            values = add('shape_model', id=uid(f'pipe:{region}:{i}'), user_id=owner,
                layer_id=uid(f'layer:pipe:{region}'), name=name, shape_type='polyline',
                geojson=dict(type='Feature', properties={}, geometry=dict(type='LineString',coordinates=coordinates)),
                created_at=created, updated_at=updated)
            attach('pipe',region,i,'shape',values,[dict(pipe_name=name,pipe_length=round(length*.98,2),material=material),
                dict(pipe_name=name,pipe_length=length,material=current_material)])

    checks = []
    def check(name, mode, kind=None, conditions=None, predicate=lambda v: True):
        selected = [a for a in answers if kind is None or a['kind']==kind]
        if mode=='latest':
            latest = {}
            for a in selected:
                if a['target'] not in latest or a['at']>latest[a['target']]['at']: latest[a['target']]=a
            selected = list(latest.values())
        selected = [a for a in selected if predicate(a['values'])]
        query = dict(mode=mode,as_of='2026-10-10T00:00:00Z',conditions=conditions or [])
        if kind: query['common_form_id']=uid(f'form:{kind}')
        checks.append(dict(name=name,owner=owner,query=query,
            expected=dict(answers=len(selected),targets=len({a['target'] for a in selected}))))
    for mode in ['history','latest']:
        check(f'{mode}-all',mode)
        check(f'{mode}-facilities',mode,'facility')
        check(f'{mode}-pipes',mode,'pipe')
        for material in MATERIALS:
            check(f'{mode}-{material}',mode,'pipe',[dict(field_id='material',field_type='select',op='in',value=[material])],
                  lambda v,m=material:v['material']==m)
        check(f'{mode}-life-50',mode,'facility',[dict(field_id='service_life',field_type='number',op='gte',value=50)],
              lambda v:v['service_life']>=50)
        check(f'{mode}-built-before-2000',mode,'facility',[dict(field_id='construction_date',field_type='date',op='lte',value='1999-12-31')],
              lambda v:v['construction_date']<='1999-12-31')
        check(f'{mode}-length-150',mode,'pipe',[dict(field_id='pipe_length',field_type='number',op='gte',value=150)],
              lambda v:v['pipe_length']>=150)
    return dict(format_version=2,profile=profile,seed=seed,rows=rows,checks=checks,
                counts=dict(Counter(row['table'] for row in rows)))


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--seed',type=int,default=20261020)
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    data=generate(args.seed)
    args.output.parent.mkdir(parents=True,exist_ok=True)
    args.output.write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps(dict(profile=data['profile'],counts=data['counts'],checks=len(data['checks'])),ensure_ascii=False))
