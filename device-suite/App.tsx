import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, SafeAreaView, ScrollView, StatusBar, StyleSheet, Text, View } from 'react-native';

import { fetchConfig, report, type HostConfig } from './src/host';
import { runBenchmarks } from './src/tasks/bench';
import { runInPlaceCheck } from './src/tasks/inPlace';
import { runScenarios } from './src/tasks/scenarios';

type Task = 'inPlace' | 'scenarios' | 'bench';

export function createApp({ reportPrefix }: { reportPrefix: string }) {
  return function App() {
    const [config, setConfig] = useState<HostConfig | null>(null);
    const [lines, setLines] = useState<string[]>([]);
    const [running, setRunning] = useState<string | null>(null);
    const autoran = useRef(false);

    const log = useCallback((line: string) => {
      console.log(`[synclaire-${reportPrefix || 'example'}] ${line}`);
      setLines(prev => [...prev, line]);
    }, []);

    const run = useCallback(
      async (cfg: HostConfig, tasks: Task[]) => {
        for (const task of tasks) {
          const targets = task === 'bench' ? [null] : cfg.backends.filter(b => task !== 'inPlace' || b.hasFixture);
          for (const backend of targets) {
            const name = backend ? `${task === 'inPlace' ? 'in-place' : 'scenarios'}-${backend.key}` : 'bench';
            setRunning(name);
            log(`--- ${name}`);
            const taskLines: string[] = [];
            const taskLog = (line: string) => {
              taskLines.push(line);
              log(line);
            };
            try {
              if (task === 'bench') {
                const results = await runBenchmarks(taskLog);
                await report(name, { ok: true, lines: taskLines, results }, reportPrefix);
              } else if (task === 'inPlace') {
                const results = await runInPlaceCheck(backend!, taskLog);
                await report(name, { ok: results.every(r => r.ok), lines: taskLines, results }, reportPrefix);
              } else {
                const results = await runScenarios(backend!, taskLog);
                await report(
                  name,
                  { ok: results.length === 8 && results.every(r => r.ok), lines: taskLines, results },
                  reportPrefix,
                );
              }
            } catch (e) {
              taskLog(`ERROR ${(e as Error).message}`);
              await report(name, { ok: false, lines: taskLines }, reportPrefix);
            }
          }
        }
        setRunning(null);
        log('--- done');
      },
      [log],
    );

    useEffect(() => {
      fetchConfig()
        .then(cfg => {
          setConfig(cfg);
          log(`host: ${cfg.backends.map(b => `${b.key}${b.hasFixture ? ' (+fixture)' : ''}`).join(', ') || 'no backends'}`);
          if (cfg.autorun && !autoran.current) {
            autoran.current = true;
            void run(cfg, ['inPlace', 'scenarios', 'bench']);
          }
        })
        .catch(e => log(`cannot reach the control server: ${(e as Error).message}`));
    }, [log, run]);

    const button = (label: string, tasks: Task[]) => (
      <Pressable
        key={label}
        style={[styles.button, (!config || running) && styles.disabled]}
        disabled={!config || !!running}
        onPress={() => config && void run(config, tasks)}
      >
        <Text style={styles.buttonText}>{label}</Text>
      </Pressable>
    );

    return (
      <SafeAreaView style={styles.container}>
        <Text style={styles.title}>{reportPrefix ? `Synclaire ${reportPrefix}` : 'Synclaire example'}</Text>
        <Text style={styles.subtitle}>{running ? `running ${running}…` : 'idle'}</Text>
        <View style={styles.row}>
          {button('In-place open', ['inPlace'])}
          {button('Scenarios', ['scenarios'])}
          {button('Benchmarks', ['bench'])}
          {button('All', ['inPlace', 'scenarios', 'bench'])}
        </View>
        <ScrollView style={styles.log} contentContainerStyle={styles.logContent}>
          {lines.map((line, i) => (
            <Text key={i} style={[styles.line, /FAIL|ERROR/.test(line) && styles.fail]}>
              {line}
            </Text>
          ))}
        </ScrollView>
        <StatusBar barStyle="dark-content" />
      </SafeAreaView>
    );
  };
}
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff', paddingTop: 48 },
  title: { fontSize: 22, fontWeight: '600', paddingHorizontal: 16 },
  subtitle: { color: '#666', paddingHorizontal: 16, marginBottom: 8 },
  row: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 12 },
  button: { backgroundColor: '#2f5d8a', borderRadius: 6, paddingVertical: 8, paddingHorizontal: 12, margin: 4 },
  disabled: { opacity: 0.4 },
  buttonText: { color: '#fff', fontWeight: '500' },
  log: { flex: 1, marginTop: 8, backgroundColor: '#f4f4f4' },
  logContent: { padding: 12 },
  line: { fontFamily: 'Menlo', fontSize: 11, marginBottom: 2 },
  fail: { color: '#b00020' },
});
