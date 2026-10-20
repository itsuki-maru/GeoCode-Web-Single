import unittest
from generate import generate, render_submission


class AnalysisFixturesTest(unittest.TestCase):
    def test_fixed_baselines(self):
        for profile, history, targets in [('small', 60, 12), ('basic', 1188, 36), ('normal', 5850, 150)]:
            with self.subTest(profile=profile):
                checks = {c['name']: c['expected'] for c in generate(profile)['checks']}
                self.assertEqual(checks['main-history-all'], dict(answers=history, targets=targets))
                self.assertEqual(checks['main-latest-all'], dict(answers=targets, targets=targets))
                self.assertEqual(checks['other-history-all'], dict(answers=2, targets=1))

    def test_determinism_and_seed_isolation(self):
        self.assertEqual(generate('small'), generate('small'))
        ids = lambda data: {r['values']['id'] for r in data['rows'] if 'id' in r['values']}
        self.assertFalse(ids(generate('small', 1)) & ids(generate('small', 2)))

    def test_references_and_saved_types(self):
        fixture = generate('basic')
        targets = {r['values']['id'] for r in fixture['rows']
                   if r['table'] in ['marker_info_model', 'shape_model']}
        configs = {r['values'].get('marker_id', r['values'].get('shape_id')): r['values']
                   for r in fixture['rows'] if r['table'].endswith('_form_config_model')}
        for row in fixture['rows']:
            if not row['table'].endswith('_form_submission_model'):
                continue
            answer = row['values']
            target = answer.get('marker_id', answer.get('shape_id'))
            self.assertIn(target, targets)
            self.assertEqual(answer['source_form'], configs[target]['source_form'])
            self.assertEqual(answer['form_snapshot']['form_schema'], configs[target]['form_schema'])
            for field in answer['form_snapshot']['form_schema']['fields']:
                value = answer['submitted_values'][field['id']]
                if field['type'] == 'checkbox':
                    self.assertIs(type(value), bool)
                elif field['type'] == 'number':
                    self.assertIn(type(value), [int, float])

    def test_known_distribution(self):
        checks = {c['name']: c['expected'] for c in generate('basic')['checks']}
        self.assertEqual(checks['history-zero'], dict(answers=64, targets=8))
        self.assertEqual(checks['latest-zero'], dict(answers=0, targets=0))
        self.assertEqual(checks['history-false'], dict(answers=576, targets=24))
        self.assertEqual(checks['latest-false'], dict(answers=12, targets=12))
        for state in ['正常', '注意', '異常']:
            self.assertEqual(checks[f'history-{state}'], dict(answers=384, targets=8))

    def test_independent_master_and_complete_popup_history(self):
        for profile in ['small', 'basic', 'normal']:
            fixture = generate(profile)
            rows = fixture['rows']
            masters = {r['values']['id'] for r in rows if r['table'] == 'layer_model' and r['values']['is_master']}
            self.assertEqual(len(masters), 2)
            for user in [r['values']['id'] for r in rows if r['table'] == 'user_model']:
                layers = [r['values'] for r in rows if r['table'] == 'layer_model' and r['values']['user_id'] == user]
                self.assertEqual(len(layers), 4)
                self.assertEqual([l['layer_name'] for l in layers if l['is_master']], ['master'])
            for row in rows:
                if row['table'] not in ['marker_info_model', 'shape_model']:
                    continue
                target = row['values']
                self.assertNotIn(target['layer_id'], masters)
                kind = 'marker' if row['table'] == 'marker_info_model' else 'shape'
                answers = sorted([r['values'] for r in rows if r['table'] == f'{kind}_form_submission_model'
                                  and r['values'][f'{kind}_id'] == target['id']], key=lambda a: (a['create_at'], a['id']))
                markdown = ''.join(a['rendered_markdown'] for a in answers)
                if kind == 'marker':
                    self.assertEqual(target['detail'], '架空の分析テスト対象' + markdown)
                    self.assertEqual(target['update_at'], answers[-1]['create_at'])
                else:
                    self.assertEqual(target['geojson']['properties']['memo'], markdown)
                    self.assertLessEqual(len(markdown), 10000)
                    self.assertEqual(target['updated_at'], answers[-1]['create_at'])

    def test_markdown_matches_normal_submission_conventions(self):
        fields = [dict(id='text', label='項目*', type='textarea'),
                  dict(id='number', label='数値', type='number'),
                  dict(id='flag', label='確認', type='checkbox')]
        result = render_submission(fields, dict(text='a_b\n<script>', number=0, flag=False), '入力[1]')
        self.assertEqual(result, '\n\n---\n\n## フォーム投稿: 入力\\[1\\]\n\n'
                         '### 項目\\*\n\na\\_b\n\\<script\\>\n\n### 数値\n\n0\n\n### 確認\n\nいいえ')


if __name__ == '__main__':
    unittest.main()
