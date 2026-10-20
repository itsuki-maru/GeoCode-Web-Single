import unittest
from generate_infrastructure import generate, MATERIALS


class InfrastructureTest(unittest.TestCase):
    def test_fixed_counts_and_materials(self):
        data=generate()
        self.assertEqual(data['counts']['marker_info_model'],24)
        self.assertEqual(data['counts']['shape_model'],36)
        self.assertEqual(data['counts']['marker_form_submission_model'],48)
        self.assertEqual(data['counts']['shape_form_submission_model'],72)
        self.assertEqual(data['counts']['layer_model'],7)
        checks={c['name']:c['expected'] for c in data['checks']}
        self.assertEqual(checks['history-all'],dict(answers=120,targets=60))
        self.assertEqual(checks['latest-all'],dict(answers=60,targets=60))
        for material in MATERIALS:
            self.assertEqual(checks[f'latest-{material}'],dict(answers=12,targets=12))
            self.assertEqual(checks[f'history-{material}'],dict(answers=24,targets=15))

    def test_connected_lines_lengths_and_complete_popups(self):
        rows=generate()['rows']
        points={(r['values']['longitude'],r['values']['latitude']) for r in rows if r['table']=='marker_info_model'}
        masters={r['values']['id'] for r in rows if r['table']=='layer_model' and r['values']['is_master']}
        self.assertEqual(len(masters),1)
        for row in rows:
            if row['table'] not in ['marker_info_model','shape_model']: continue
            target=row['values']
            self.assertNotIn(target['layer_id'],masters)
            kind='marker' if row['table']=='marker_info_model' else 'shape'
            answers=sorted([r['values'] for r in rows if r['table']==f'{kind}_form_submission_model'
                            and r['values'][f'{kind}_id']==target['id']],key=lambda a:a['create_at'])
            self.assertEqual(len(answers),2)
            markdown=''.join(a['rendered_markdown'] for a in answers)
            if kind=='marker':
                self.assertTrue(target['detail'].endswith(markdown))
                self.assertEqual(len(answers[-1]['submitted_values']['construction_date']),10)
            else:
                self.assertEqual(target['shape_type'],'polyline')
                coordinates=target['geojson']['geometry']['coordinates']
                self.assertIn(tuple(coordinates[0]),points)
                self.assertIn(tuple(coordinates[-1]),points)
                value=answers[-1]['submitted_values']
                self.assertGreater(value['pipe_length'],80)
                self.assertLess(value['pipe_length'],300)
                self.assertIn(value['material'],MATERIALS)
                self.assertEqual(target['geojson']['properties']['memo'],markdown)
                self.assertLessEqual(len(markdown),10000)

    def test_reproducible_and_independent_from_existing_sets(self):
        self.assertEqual(generate(),generate())
        from generate import generate as generic
        ids=lambda data:{r['values']['id'] for r in data['rows'] if 'id' in r['values']}
        self.assertFalse(ids(generate()) & ids(generic('basic')))
        self.assertFalse(ids(generate(1)) & ids(generate(2)))


if __name__=='__main__':
    unittest.main()
