# EvoRace — Laboratório de Pilotos

Jogo 2D (visão de cima) que roda no navegador. Você cria redes neurais que pilotam pequenos monopostos e treina populações por **evolução**: os carros começam dirigindo mal, os melhores cérebros viram pais, e a cada geração os pilotos avançam mais, completam voltas e ficam mais rápidos. Uma **IA treinadora** pode organizar experimentos sozinha, e um **ranking público online** guarda os melhores tempos — validados pelo servidor, que roda a corrida de novo com o mesmo motor do jogo.

Tudo de treino, redes, treinadora, campeonatos e editor funciona **localmente e sem internet**. O servidor só é necessário para o ranking público.

---

## Como rodar

Requisitos: **Node.js 22.18 ou mais novo** (recomendado 24). O servidor usa o SQLite embutido no Node (`node:sqlite`) e executa TypeScript diretamente — não há dependências nativas para compilar.

```bash
npm install
```

**Desenvolvimento** (dois terminais):

```bash
npm run server
```

```bash
npm run dev
```

Abra http://localhost:5173. O Vite repassa `/api` para o servidor do ranking em http://localhost:8787. Sem o servidor, o jogo funciona normalmente e as telas online mostram “Ranking online indisponível”.

**Produção** (jogo + ranking no mesmo endereço):

```bash
npm run build
```

```bash
npm run server
```

O servidor serve a pasta `dist/` e a API em http://localhost:8787.

**Testes e verificações:**

```bash
npm test
```

```bash
npm run verify:training -- circuito-misto 100 1,2,3 50
```

```bash
npm run bench
```

---

## Publicar o ranking online

O ranking precisa de um servidor Node com **disco persistente** (o banco é um arquivo SQLite). Qualquer VPS ou serviço que rode containers com volume serve (Fly.io, Railway, Render com disco, etc.).

Com Docker:

```bash
docker build -t evorace .
```

```bash
docker run -p 8787:8787 -v evorace-data:/data evorace
```

Variáveis de ambiente do servidor:

| Variável | Padrão | Para que serve |
|---|---|---|
| `PORT` | `8787` | Porta HTTP |
| `HOST` | `0.0.0.0` | Interface de rede |
| `DB_PATH` | `./data/evorace.db` | Arquivo do banco (as migrações em `server/migrations` rodam sozinhas) |
| `STATIC_DIR` | `./dist` | Jogo compilado (servido se existir) |
| `CORS_ORIGIN` | `*` | Origem permitida para a API, se o jogo estiver em outro domínio |
| `TRUST_PROXY` | — | `1` para usar `X-Forwarded-For` nos limites por IP (atrás de proxy) |

Se o jogo for hospedado separado (ex.: GitHub Pages) e a API em outro domínio, compile com `VITE_API_URL=https://seu-servidor` e configure `CORS_ORIGIN` com o domínio do jogo. Nenhum segredo vai para o front-end: a autenticação usa tokens de sessão aleatórios guardados com hash no banco.

> **Estado atual:** o servidor foi testado localmente (jogo + API + validação). Ele **não está publicado** em nenhum endereço público — para que outras pessoas vejam o ranking, é preciso hospedá-lo como acima.

---

## Como o jogo funciona

**Telas:** Início, Laboratório (pista ao vivo, configurações, estatísticas, gráficos, aba da treinadora), Resultados (evolução, replays, mapa de mortes, outras pistas, comparação, histórico da treinadora, envio ao ranking), Garagem (pilotos, laboratórios, configurações, treinadoras, linhagens, replays — renomear, duplicar, exportar, importar, excluir), Pistas (prontas, personalizadas, editor, teste dirigindo, teste com piloto), Campeonato (local) e Ranking (online).

**Física (`src/core/physics.ts`):** modelo cinemático de bicicleta com passo fixo de 1/60 s. Esterçamento máximo cai com a velocidade, e a curvatura possível é limitada pela aderência lateral (24 m/s²): acima disso o carro "sai de frente" e perde velocidade. Volante e pedais respondem gradualmente. Freio acima de 50% tem prioridade e anula o acelerador. Acelerar a simulação (2×, 5×, 10×, máximo) só executa mais passos por segundo real — o passo nunca muda.

**Colisões:** o corpo inteiro (4,6 × 1,9 m, o mesmo retângulo do desenho) é testado: arestas na nova posição e a trajetória de cada canto entre passos, para não atravessar bordas em alta velocidade. Carros não colidem entre si.

**Progresso sem brechas (`src/core/sim.ts`):** a posição é projetada na linha central buscando só perto da última posição conhecida (não confunde trechos vizinhos). Só conta avanço **novo**; voltar e repassar não rende pontos; o progresso nunca passa do próximo checkpoint não cruzado; checkpoints valem só em ordem, pelo segmento percorrido e no sentido certo; a volta só fecha após todos os checkpoints e a linha de chegada no sentido certo (o carro nasce 6 m depois dela).

**Sensores e entradas (`src/core/sensors.ts`):** 5, 9 ou 13 raios de distância (até 120 m), velocidade e direção anterior (sensores físicos); opcionalmente ângulo em relação à pista (seno e cosseno), deslocamento lateral e direção de pontos a 25 m e 60 m (informações da pista). Tudo normalizado em 0..1 ou −1..1.

**Redes (`src/core/nn.ts`):** feedforward, camadas ocultas com tanh, saídas direção (tanh), acelerador e freio (sigmoide). Pesos iniciados com desvio 1/√entradas. O genoma é um `Float64Array` de pesos e vieses; a interface mostra parâmetros e operações por passo.

**Evolução (`src/core/evolution.ts`):** elite copiada sem mutação, pais por truncamento (melhores X%) ou torneio — ambos por ordem, então pontuações negativas funcionam —, cruzamento opcional por neurônio (só entre arquiteturas iguais), mutação gaussiana com **probabilidade** e **intensidade** separadas, e pilotos novos a cada geração. O melhor histórico é guardado como cópia independente. Começa com 50 carros, elite 4, pais entre os 20% melhores, mutação 10% × 0,15.

**Recompensas (`src/core/rewards.ts`):** progresso novo, checkpoints inéditos, conclusão, tempo, colisão, ficar parado, recuo e oscilação da direção — normalizados pelo comprimento da volta e por um tempo de referência. Presets: Aprender a completar, Buscar velocidade, Priorizar consistência e Personalizado. Quem não completa paga o tempo máximo, para que bater cedo não vire vantagem.

**Avaliação oficial (`src/core/evaluation.ts`, fixa):** uma tentativa — completou > não completou; menor tempo; maior progresso; menor tempo até o progresso. Várias tentativas — taxa de conclusão; mediana dos tempos; progresso médio; melhor tempo. O laboratório guarda separados o campeão por recompensa e o campeão oficial.

**Treinadora (`src/core/coach.ts`):** busca aleatória (o 1º experimento é sempre a sua configuração), depois perturbação das melhores; aumenta a variedade quando estagna. Cada configuração recebe o **mesmo orçamento em passos-carro** e as mesmas sementes. Pistas de treino produzem pilotos, as de validação orientam as escolhas e as de teste final são usadas **uma única vez** no fim. As mensagens vêm dos eventos reais (nova melhor, mais rápido mas completa menos, rede menor com resultado semelhante, estagnação).

**Determinismo:** a simulação usa só `+ − × ÷` e `Math.sqrt` (seno, cosseno, exponencial, logaritmo e tanh próprios em `src/core/dmath.ts`) e um gerador SFC32 com semente. Como só usa operações que o padrão IEEE-754 obriga a serem exatas, o mesmo cérebro deve dar o mesmo tempo em qualquer navegador e no servidor (verificado num navegador Chromium e no Node; outros navegadores não foram testados — se houver diferença, vale o resultado do servidor). Retomar um experimento salvo dá exatamente o mesmo resultado que não ter parado (coberto por teste).

## Ranking e validação

* Consulta pública sem login; envio com apelido e senha (scrypt) e token de sessão.
* O jogador envia só o cérebro (pesos em base64, arquitetura e sensores). O servidor valida formato, dimensões e valores, confere a categoria (entradas e limites de arquitetura), roda a tentativa oficial numa worker thread com limite de tempo e memória e calcula o **tempo simulado**. Tempos enviados pelo cliente são ignorados.
* Fila com estados: aguardando, validando, aprovado, não concluiu, rejeitado por configuração inválida, erro temporário (com nova tentativa automática).
* Só a fila de validação escreve em `records`; um recorde por jogador por pista/categoria/versão, atualizado só quando melhora; replay oficial guardado.
* Categorias: **Sensores** (só sensores físicos, até 3 camadas × 32 neurônios, 4.000 parâmetros) e **Aberta** (qualquer entrada, até 4 × 64, 20.000 parâmetros). A versão das regras (`r1.f1.p1` = regras, física, pista) separa classificações; versões antigas continuam consultáveis.
* Limites: 3 envios na fila por jogador, 30 por hora, 300 KB por envio, cadastro e login limitados por IP.

## Verificação do aprendizado

Treinos com sementes fixas, 50 carros, configuração padrão (“Aprender a completar”), 100 gerações (`npm run verify:training`). Nenhum carro tem direção programada: só redes evoluídas.

| Pista (dificuldade) | 1ª volta completa (sementes 1 / 2 / 3) | Melhor volta oficial | Resultado |
|---|---|---|---|
| Oval Largo (1) | geração 3 / 9 / 1 | 28,183 / 29,402 / 28,650 s | 3/3 completaram |
| Curvas em S (2) | geração 11 / 20 / 11 | 35,576 / 35,451 / 38,977 s | 3/3 completaram |
| Trechos Estreitos (3) | geração 23 / 16 / 28 | 38,949 / 36,181 / 39,715 s | 3/3 completaram |
| Retas e Grampos (4) | geração 30 / 39 / 26 | 65,119 / 63,890 / 61,020 s | 3/3 completaram |
| Circuito Misto (5) | geração 35 / 37 / 23 | 47,208 / 41,862 / 39,382 s | 3/3 completaram |

Com o preset “Aprender a completar” o tempo para de cair depois que a volta fecha (todos que completam ganham a mesma pontuação). Para baixar o tempo, troque para “Buscar velocidade” — a mudança entra na próxima geração sem perder o treino.

A ordem de dificuldade das pistas foi definida por essa medição. Evolução é estocástica: os números variam com a semente, mas os melhores resultados são sempre preservados (elite + campeão histórico).

## Desempenho

Medido com `npm run bench` (Node 24, treino real na pista Curvas em S; passos-carro = um carro avançando 1/60 s).

| População | Antes da otimização | Depois | Força bruta (sem grade) |
|---|---|---|---|
| 20 | 282 mil/s | 412 mil/s | 21–25 mil/s |
| 50 | 289 mil/s | 407 mil/s | 21–25 mil/s |
| 100 | 288 mil/s | 404 mil/s | — |
| 200 | 282 mil/s | 402 mil/s | — |

Gargalos encontrados com perfil de CPU e o que foi feito:

1. **Raios dos sensores** (37% do tempo): já usavam grade espacial (14× mais rápido que testar todos os segmentos); reduzir a célula de 16 m para 8 m deixou cada raio ~25% mais rápido.
2. **Rede neural** (31%): o `tanh` determinístico custava 32 ns (o nativo, 14 ns). A exponencial passou a usar uma tabela exata de 2^(j/64) e um polinômio curto — continua idêntica em qualquer navegador.
3. **Colisão** (11%): agora pulamos o teste quando o carro está comprovadamente longe das bordas (largura segura pré-calculada por trecho). Um teste prova que o resultado é idêntico com e sem esse atalho.

Resultado: **+42%** de passos por segundo, sem mudar física nem regras. Depois disso, rede (42%) e raios (33%) dominam — trabalho essencial. Outras medidas: simulação em Web Workers, mensagens resumidas (Float32Array transferido), React atualizado no máximo 5×/s, desenho a 30 quadros/s no modo de baixo consumo, histórico e mapa de mortes limitados, replays de um carro por vez (30 quadros/s, ~34 KB por volta).

No navegador, com 50 carros no modo máximo, medimos ~10 mil passos de simulação por segundo (~165× tempo real) num computador comum. **Cada aparelho é diferente:** em Configurações → “Medir desempenho deste aparelho” o jogo mede com 20, 50, 100 e 200 carros e sugere uma população.

## Organização do código

| Módulo | Arquivos |
|---|---|
| Física | `src/core/physics.ts` |
| Geometria e colisões | `src/core/geometry.ts`, `src/core/sim.ts` |
| Pistas | `src/core/track.ts`, `src/core/builtinTracks.ts`, `src/core/trackValidation.ts` |
| Sensores | `src/core/sensors.ts` |
| Redes neurais | `src/core/nn.ts`, `src/core/dmath.ts` |
| Evolução | `src/core/evolution.ts`, `src/core/trainer.ts`, `src/core/rng.ts` |
| Recompensas | `src/core/rewards.ts` |
| Avaliação | `src/core/evaluation.ts`, `src/core/rules.ts`, `src/core/official.ts` |
| Treinadora | `src/core/coach.ts` |
| Campeonatos | `src/core/championship.ts` |
| Replays | `src/core/replay.ts`, `src/ui/ReplayPlayer.tsx` |
| Persistência | `src/persistence/db.ts` (IndexedDB), `src/core/io.ts` (JSON versionado) |
| Áudio | `src/audio/audio.ts` (Web Audio, procedural) |
| Interface | `src/ui/` (React), `src/ui/render/draw.ts` (Canvas 2D), `src/workers/` |
| Ranking e validação online | `server/`, `src/online/` |

O núcleo (`src/core`) não usa DOM nem Canvas: roda nos testes, nos workers e no servidor.

## Limitações conhecidas

* O ranking precisa ser hospedado para ser público (veja acima); localmente ele funciona completo.
* Desempenho e tempo das treinadoras variam muito entre aparelhos; celulares antigos podem ficar lentos com 100–200 carros.
* Com a aba ou a janela do navegador em segundo plano, o sistema reduz a prioridade da página e o treino fica bem mais lento (medimos ~5× menos). O resultado não muda — só demora mais.
* As pistas personalizadas valem para treino e campeonatos locais; o ranking usa só as cinco pistas oficiais.
* A validação do editor confere a geometria (fechamento, largura, cruzamentos, curvas), mas não garante que a pista seja fácil — use “Testar dirigindo” ou treine um piloto.
* Se a física, as regras ou uma pista oficial mudarem, é preciso aumentar a versão em `src/core/rules.ts`/`physics.ts`/`builtinTracks.ts`; a classificação antiga continua consultável como histórico.
