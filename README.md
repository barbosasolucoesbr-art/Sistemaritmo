# Ritmo

PWA para organizar a rotina, com visual escuro inspirado no iPhone.

Aplicativo: https://barbosasolucoesbr-art.github.io/Sistemaritmo/

## Instalar no iPhone

Abra o endereço no Safari, toque em **Compartilhar → Adicionar à Tela de Início** e abra o Ritmo pelo ícone criado. Em **Ajustes → Conta**, crie sua conta, confirme o e-mail e entre no aplicativo instalado.

Os dados anteriores do Safari podem não aparecer automaticamente no aplicativo instalado. Se necessário, exporte um backup no navegador e importe em **Ajustes → Importar backup** no app.

## Onde ficam os dados

- Sem login: registros locais no navegador/aplicativo, em IndexedDB (com alternativa em localStorage).
- Com login: cópia local por conta e sincronização com o banco Supabase do projeto `yndqagqgbimmoymlatgi`.
- Ao reconectar ou reabrir o app: os registros pendentes são sincronizados. Confira o estado na tela **Conta**.
- **Importar registros deste aparelho** transfere os registros locais anteriores para a conta conectada. Eles deixam de aparecer no modo sem login.
- Registros são protegidos por autenticação e políticas de acesso por usuário (RLS). A chave pública no código não permite ler registros sem uma sessão válida.
- O cache offline guarda os arquivos do aplicativo. As respostas do banco não entram no cache do service worker.
- O repositório contém o aplicativo e o esquema do banco; não contém configurações pessoais de medicamentos, backups ou senhas.

Alterações em campos diferentes são combinadas. Se dois aparelhos alterarem o mesmo campo, a tela Conta pede qual versão manter. Não há sobrescrita silenciosa. Para substituir todos os registros por um backup ou apagá-los com uma conta conectada, é necessário estar online e concluir a sincronização primeiro.

Ao sair, os registros da conta permanecem guardados nesse dispositivo e ficam ocultos até entrar novamente na mesma conta. Apagar os dados do Safari ou remover o aplicativo pode apagar registros que ainda não foram sincronizados. Exporte backups para o app Arquivos quando necessário. Não há criptografia ponta a ponta: administradores do projeto Supabase têm acesso administrativo ao banco.

## Autenticação

O Site URL e o redirect autorizado no Supabase são o endereço HTTPS acima. O cadastro usa e-mail e senha, com confirmação de e-mail. O envio padrão do Supabase é restrito a e-mails de membros do projeto; para outros usuários, configure um provedor SMTP próprio no painel. Nunca coloque credenciais SMTP ou chaves secretas no frontend.

## Publicação e desenvolvimento

Arquivos estáticos na raiz do branch `main`, publicados pelo GitHub Pages. Não é necessário compilar. `schema.sql` documenta a estrutura aplicada ao Supabase e deve ser usado uma única vez em um banco novo. A sincronização usa a função `ritmo_save_record`, que verifica a revisão e a identidade autenticada.

Execute `npm test` com Node.js para testar persistência, isolamento por conta, falhas de rede, migração local e conflitos. O SDK Supabase está fixado e incluído no repositório para abertura offline; veja `DEPENDENCIES.md`.

Ao alterar os arquivos do aplicativo, incremente a versão do cache em `sw.js`. Para receber uma atualização no iPhone, abra online, feche o Ritmo e abra novamente. Os dados pessoais ficam separados do cache do aplicativo.

O Ritmo registra informações inseridas pelo usuário. Não envia notificações de medicamentos em segundo plano e não se conecta ao Apple Saúde.
