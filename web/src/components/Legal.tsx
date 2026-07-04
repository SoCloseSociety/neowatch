import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ArrowLeft, ScrollText, ShieldCheck } from 'lucide-react';
import { useT } from '@/lib/i18n';

// Terms of use + privacy policy, on one page with anchors (#cgu / #confidentialite).
// FR-first legal copy (primary market); the structure is what matters for go-live.
export function Legal() {
  const navigate = useNavigate();
  const { hash } = useLocation();
  const t = useT();

  useEffect(() => {
    if (!hash) return;
    document.getElementById(hash.slice(1))?.scrollIntoView({ block: 'start' });
  }, [hash]);

  return (
    <main className="flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[860px] px-5 py-8 text-[13.5px] leading-relaxed text-ink-2">
        <button onClick={() => navigate(-1)} className="mb-6 flex items-center gap-1.5 rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-1.5 text-[12px] text-ink-2 hover:border-accent hover:text-accent">
          <ArrowLeft size={14} /> {t('detail.back')}
        </button>

        <section id="cgu" className="mb-12 scroll-mt-6">
          <h1 className="mb-1 flex items-center gap-2 text-[24px] font-extrabold text-ink"><ScrollText size={22} className="text-accent" /> Conditions d'utilisation</h1>
          <p className="mb-5 font-mono text-[11px] text-ink-3">Dernière mise à jour : juin 2026</p>

          <h2 className="mb-1.5 mt-6 text-[16px] font-bold text-ink">1. Le service</h2>
          <p>NEOWATCH est un agrégateur et lecteur de flux audiovisuels librement accessibles au public : chaînes de télévision référencées par l'annuaire communautaire <a href="https://iptv-org.github.io" target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">iptv-org</a>, radios référencées par l'annuaire <a href="https://www.radio-browser.info" target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">radio-browser</a>, et films du domaine public hébergés par <a href="https://archive.org" target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">Internet Archive</a>. NEOWATCH n'héberge, ne produit et ne modifie aucun contenu audiovisuel : le service indexe des flux publiés et rendus publiquement accessibles par leurs diffuseurs respectifs, et les lit depuis leur source.</p>

          <h2 className="mb-1.5 mt-6 text-[16px] font-bold text-ink">2. Contenus tiers</h2>
          <p>Les flux référencés appartiennent à leurs diffuseurs. Leur disponibilité, leur qualité et leur licéité relèvent de la responsabilité de leurs éditeurs. Si vous êtes ayant droit d'un contenu référencé et souhaitez son retrait, contactez-nous (section 6) : le flux sera déréférencé rapidement. L'abonnement Premium rémunère exclusivement des fonctionnalités logicielles du service (multi-écran, guide TV, absence de publicité, synchronisation, playlists personnelles) et en aucun cas l'accès à des contenus de tiers.</p>

          <h2 className="mb-1.5 mt-6 text-[16px] font-bold text-ink">3. Usage acceptable</h2>
          <p>Vous vous engagez à utiliser NEOWATCH dans le respect du droit applicable dans votre pays, à ne pas revendre l'accès au service, à ne pas tenter de contourner ses limitations techniques et à ne pas l'utiliser pour porter atteinte aux droits de tiers.</p>

          <h2 className="mb-1.5 mt-6 text-[16px] font-bold text-ink">4. Abonnement et paiement</h2>
          <p>L'abonnement Premium est facturé au tarif affiché sur la page Premium, pour la durée indiquée, sans reconduction cachée. Il peut être résilié à tout moment depuis le compte ; l'accès Premium reste actif jusqu'à la fin de la période payée. Le paiement est traité par un prestataire tiers (Stripe) ; NEOWATCH ne stocke aucune donnée bancaire.</p>

          <h2 className="mb-1.5 mt-6 text-[16px] font-bold text-ink">5. Garanties et responsabilité</h2>
          <p>Le service est fourni « en l'état ». La disponibilité des flux tiers n'est pas garantie. NEOWATCH ne saurait être tenu responsable des interruptions, des contenus diffusés par les chaînes tierces, ni des dommages indirects liés à l'utilisation du service.</p>

          <h2 className="mb-1.5 mt-6 text-[16px] font-bold text-ink">6. Contact</h2>
          <p>Pour toute question, demande de retrait ou réclamation : <span className="font-mono text-accent">sin.soclose@gmail.com</span>.</p>
        </section>

        <section id="confidentialite" className="scroll-mt-6">
          <h1 className="mb-1 flex items-center gap-2 text-[24px] font-extrabold text-ink"><ShieldCheck size={22} className="text-accent" /> Politique de confidentialité</h1>
          <p className="mb-5 font-mono text-[11px] text-ink-3">Dernière mise à jour : juin 2026</p>

          <h2 className="mb-1.5 mt-6 text-[16px] font-bold text-ink">1. Données collectées</h2>
          <p>Compte : adresse email, nom facultatif, mot de passe (stocké haché avec bcrypt, jamais en clair), plan d'abonnement, favoris et configuration multi-écran si vous choisissez de les synchroniser. Aucune donnée bancaire n'est stockée par NEOWATCH (paiement traité par Stripe). Le service n'utilise pas de traceurs publicitaires tiers ni de revente de données.</p>

          <h2 className="mb-1.5 mt-6 text-[16px] font-bold text-ink">2. Stockage local</h2>
          <p>L'application enregistre dans votre navigateur (localStorage) vos préférences d'affichage, votre thème, vos favoris locaux, vos recherches récentes et votre jeton de session. Ces données restent sur votre appareil et peuvent être effacées en vidant les données du site.</p>

          <h2 className="mb-1.5 mt-6 text-[16px] font-bold text-ink">3. Journaux techniques</h2>
          <p>Le serveur conserve des journaux techniques minimaux (erreurs, limitation de débit par adresse IP) nécessaires à la sécurité et au bon fonctionnement, purgés régulièrement.</p>

          <h2 className="mb-1.5 mt-6 text-[16px] font-bold text-ink">4. Vos droits (RGPD)</h2>
          <p>Vous pouvez consulter, corriger ou supprimer vos données à tout moment : la suppression de compte est disponible directement dans le panneau « Mon compte » et efface immédiatement l'ensemble des données associées (email, favoris, configuration). Pour toute autre demande : <span className="font-mono text-accent">sin.soclose@gmail.com</span>.</p>

          <h2 className="mb-1.5 mt-6 text-[16px] font-bold text-ink">5. Lecture des flux</h2>
          <p>La lecture s'effectue en priorité directement depuis la source du diffuseur : votre adresse IP est alors visible de ce diffuseur, comme pour toute lecture web. Lorsqu'un flux nécessite le relais du serveur NEOWATCH (compatibilité technique), c'est l'adresse du serveur qui est visible de la source.</p>
        </section>
      </div>
    </main>
  );
}
