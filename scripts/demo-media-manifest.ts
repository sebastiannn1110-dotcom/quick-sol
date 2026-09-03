export type DemoMediaSource = "Pexels" | "Unsplash";

export type DemoMediaAsset = Readonly<{
  localPath: string;
  imageUrl: string;
  imageSource: DemoMediaSource;
  sourcePageUrl: string;
  credit: string;
  licenseUrl: string;
  sha256: string;
  width: number;
  height: number;
  assetType: "conventional-stock-photo";
  aiGenerated: false;
  reviewedAt: "2026-08-30";
}>;

const PEXELS_LICENSE = "https://www.pexels.com/license/";
const UNSPLASH_LICENSE = "https://unsplash.com/license";

function stockPhoto(
  localPath: string,
  imageUrl: string,
  imageSource: DemoMediaSource,
  sourcePageUrl: string,
  credit: string,
  sha256: string,
  width: number,
  height: number
): DemoMediaAsset {
  return Object.freeze({
    localPath,
    imageUrl,
    imageSource,
    sourcePageUrl,
    credit,
    licenseUrl: imageSource === "Pexels" ? PEXELS_LICENSE : UNSPLASH_LICENSE,
    sha256,
    width,
    height,
    assetType: "conventional-stock-photo" as const,
    aiGenerated: false as const,
    reviewedAt: "2026-08-30" as const
  });
}

function person(
  fileName: string,
  photoId: string,
  sourceSlug: string,
  credit: string,
  sha256: string
) {
  return stockPhoto(
    "demo/people/" + fileName + ".webp",
    "https://images.pexels.com/photos/" + photoId + "/pexels-photo-" + photoId + ".jpeg?auto=compress&cs=tinysrgb&w=1200",
    "Pexels",
    "https://www.pexels.com/photo/" + sourceSlug + "/",
    credit,
    sha256,
    512,
    512
  );
}

export const DEMO_PERSON_MEDIA = Object.freeze({
  olivia: person("olivia", "4427506", "businesswoman-sitting-in-her-office-4427506", "August de Richelieu", "e8006a96b80d9b8c607ed5d4a25a8fd6874ae6585ce6e56d326bac6d29d8f2ea"),
  daniel: person("daniel", "30004315", "professional-headshot-of-smiling-businessman-30004315", "Daniel & Hannah Snipes", "2f231516239e994eb1f67ab7ab6bd002dd91dcd927baa3730dd65da588e4ac83"),
  maya: person("maya", "37302655", "portrait-of-smiling-professional-woman-in-office-wear-37302655", "Erick Ortega", "25163c6ac4376f34ace96ebed7fab05f55197e5004a343ee396fa0aea2b66bdf"),
  jordan: person("jordan", "32012999", "professional-headshot-of-confident-businessman-in-lagos-32012999", "Alpha Iliya", "d0b4513f0e5fb840e439f7a0b609c2d041a9df9e61ed0eeca4993b8818c7455a"),
  sofia: person("sofia", "30468665", "professional-headshot-of-a-young-businesswoman-30468665", "Augusto Carneiro Junior", "55d842084c0dfb977073a5c12d8ce624a1e74f4430e3bd06e01fd6d0118e9ee4"),
  lucas: person("lucas", "4342400", "a-businessman-on-a-phone-call-4342400", "Edmond Dantès", "f920ed68b903e8df949c6cc8a5334fe5457c5d800aff919351bf0a7477d47a35"),
  emma: person("emma", "12437059", "photo-of-a-woman-wearing-eyeglasses-and-a-white-blouse-12437059", "Lubomir Satko", "621d0cdeafcf2a867921e2272e6ee886979b02725eb903587def963d07834f15"),
  priya: person("priya", "18890945", "indian-woman-in-an-office-18890945", "Rajib Ahmed", "0838c8f678da8ff3eb49f446b281bc86ba7a757f8e6775b1a5ee97126036263e"),
  ethan: person("ethan", "16370549", "portrait-of-a-businessman-giving-a-thumbs-up-16370549", "Wasin Pirom", "1707d124414d8e67ab1cca5c2afb208c1a7ccd984eca89d58050d39568a49198"),
  liNa: person("li-na", "7964415", "portrait-of-a-confident-woman-wearing-bright-jacket-in-an-office-7964415", "Felicity Tai", "45a4d4f85b8f7489337acafd34be14f799d9c3b2f28c2458f36d7cbffb3b4a08"),
  haruto: person("haruto", "29995581", "professional-businessman-in-a-formal-suit-portrait-29995581", "Tran Nhu Tuan", "d89143a87c4a9f5ae2d383a51b4fa2ec3c1d2a36c74d4b671c97679bf5def20d"),
  minJun: person("min-jun", "31268616", "professional-portrait-of-a-businessman-in-studio-31268616", "Duy's House of Photo", "1f5e4358aa03437c92e317268ac15b4a149fcdb58fbfd27a0f21a61c698cb5f6"),
  chloe: person("chloe", "785667", "close-up-photography-of-a-woman-wearing-formal-coat-785667", "Andrea Piacquadio", "72e5e4f0b14dbbaabb47ff57362844eb4bd091fdfb6a52ee97be930c2100fb63"),
  lukas: person("lukas", "8937579", "portrait-of-a-businessman-8937579", "Mikhail Nilov", "92c9126e7763b0a3fea703bcff4c1dd34591b610757a6a0914a1e020337574f1"),
  hannah: person("hannah", "3757946", "confident-businesswoman-sharing-information-from-documents-in-workplace-3757946", "Andrea Piacquadio", "62cb4134871b26c6d97f6aef5537292bfe63622e443aa963f16e423d0c4c5a2e"),
  camille: person("camille", "4342352", "confident-businesswoman-4342352", "Edmond Dantès", "b9b24f3c3c70bbf87d1a3abcd83c6cb361e8908dfee60e7e694be167ed2e9ec8"),
  oliver: person("oliver", "3865599", "senior-confident-businessman-sitting-in-computer-chair-during-job-with-colleagues-in-daytime-3865599", "Andrea Piacquadio", "8f9742183775c4eeaeaabaf16c39e9b0d4f20e87b9ed5c8da23805e991c5da08"),
  lucia: person("lucia", "3747435", "portrait-of-woman-in-office-3747435", "Polina Zimmerman", "d91e4f8ba4bd5e8a496e1f6d6072e9ae6be22366830f102c321acf8da6f28829"),
  lin: person("lin", "31880922", "professional-portrait-of-a-businessman-in-suit-31880922", "Wasin Pirom", "72880e64f90a9afd90f290a6a40b8f00801d5eb1c7d2975b9ae37a7151bb8c01")
});

function company(
  fileName: string,
  imageUrl: string,
  imageSource: DemoMediaSource,
  sourcePageUrl: string,
  credit: string,
  sha256: string
) {
  return stockPhoto(
    "demo/companies/" + fileName + ".webp",
    imageUrl,
    imageSource,
    sourcePageUrl,
    credit,
    sha256,
    1200,
    700
  );
}

export const DEMO_COMPANY_MEDIA = Object.freeze({
  novaCircuit: company("nova-circuit", "https://images.unsplash.com/photo-1562408590-e32931084e23?auto=format&fit=crop&w=1600&q=80", "Unsplash", "https://unsplash.com/photos/blue-circuit-board-jXd2FSvcRr8", "Umberto (@umby)", "b9a25996f1159f918c39f8548060941dd382fd58fc81cbc6b1688c9d22736bd9"),
  atlasRobotics: company("atlas-robotics", "https://images.pexels.com/photos/34207359/pexels-photo-34207359.jpeg?cs=srgb&dl=pexels-freek-wolsink-508219-34207359.jpg&fm=jpg", "Pexels", "https://www.pexels.com/photo/industrial-robot-arm-in-a-manufacturing-facility-34207359/", "Freek Wolsink", "98bfd26aeb78c47b3b6882b043e1fca820cb00dd2d339e8e7a01d76bcf4fec0b"),
  andinaControls: company("andina-controls", "https://images.unsplash.com/photo-1780034766228-3fd70d9463c3?auto=format&fit=crop&w=1600&q=80", "Unsplash", "https://unsplash.com/photos/industrial-control-panel-with-electronic-modules-and-colorful-wiring-UEx6fTODHzI", "Raymond Sime (@raymond36)", "e028d8463fb4a874699af20f1ae6548cbf1ab4236c1649f294aebad57f17cad3"),
  northStarDevices: company("north-star-devices", "https://images.unsplash.com/photo-1516549655169-df83a0774514?auto=format&fit=crop&w=1600&q=80", "Unsplash", "https://unsplash.com/photos/operating-room-with-surgical-table-LPurJnihmQI", "Marcel Scholte (@mscholte)", "0476a575f8e06e82f6d45584ebe18e8fa958fc1222eda2a9981bbbd89bdf10b9"),
  pacificaEnergy: company("pacifica-energy", "https://images.unsplash.com/photo-1745187794292-ba0014281746?auto=format&fit=crop&w=1600&q=80", "Unsplash", "https://unsplash.com/photos/solar-panels-cover-a-factory-roof-0koGZEQQ48Q", "Rafael Moreno (@rafamrn)", "10a589eaa9b51739b9a72757f8142449f22ae683e61e61ea120cb99bb8b9bc2f"),
  mapleGrid: company("maple-grid", "https://images.unsplash.com/photo-1780396140802-52309c205050?auto=format&fit=crop&w=1600&q=80", "Unsplash", "https://unsplash.com/photos/electrical-substation-with-transformers-and-power-lines-against-blue-sky-bbqAh039s6U", "Jose Manuel Esp", "c1d7194783beb182987eadedd02f5438c8c328f979ee54848f4c54b1b7b4f44e"),
  blueMesa: company("blue-mesa", "https://images.pexels.com/photos/9242281/pexels-photo-9242281.jpeg?cs=srgb&dl=pexels-mikhail-nilov-9242281.jpg&fm=jpg", "Pexels", "https://www.pexels.com/photo/man-in-goggles-working-on-hardware-9242281/", "Mikhail Nilov", "b1577ee9bf34bbbceb13a8cd1ce8518a0a8449966f476acc8e960825ce584201"),
  libertyMotion: company("liberty-motion", "https://images.unsplash.com/photo-1759159091682-3b98f4759367?auto=format&fit=crop&w=1600&q=80", "Unsplash", "https://unsplash.com/photos/close-up-of-industrial-machinery-with-gears-and-dials-td2Qd8nrPLE", "Hans Westbeek", "cf314194ee7df8fa19ca173edbc015815bf275642535c376e9101eaa211b6bf1"),
  lionCity: company("lion-city", "https://images.pexels.com/photos/29224591/pexels-photo-29224591.jpeg?auto=compress&cs=tinysrgb&w=1600", "Pexels", "https://www.pexels.com/photo/industrial-factory-interior-with-metal-equipment-29224591/", "Cemrecan Yurtman", "ba8e884cd73f0c6b2b3222e20ab20098ff69cc15530295ba43b03bd4822812b0"),
  pearlRiver: company("pearl-river", "https://images.unsplash.com/photo-1774128542316-c74faefb14dd?auto=format&fit=crop&w=1600&q=80", "Unsplash", "https://unsplash.com/photos/old-industrial-control-panel-with-gauges-and-buttons-QuXxw9OsYbo", "Udo Meyer", "8ccfa6b70ba278840b99d002681a9648ee6e38b4d6defd8975bdefbcde62aec3"),
  meridianSemi: company("meridian-semi", "https://images.unsplash.com/photo-1765256931287-e7f0e36b9ba4?auto=format&fit=crop&w=1600&q=80", "Unsplash", "https://unsplash.com/photos/close-up-of-a-green-circuit-board-with-microchips-dXdr1RGvcoM", "Albert Stoynov", "ee1c7753a3e0c1a474c2cc9888312fa836a00eeafc48a0d6bf18a5554f4cd7d9"),
  rheinWerk: company("rhein-werk", "https://images.unsplash.com/photo-1666618090858-fbcee636bd3e?auto=format&fit=crop&w=1600&q=80", "Unsplash", "https://unsplash.com/photos/a-close-up-of-a-machine-DV_rG1mjDxs", "Sven Daniel", "2c3db43314bb7713c7b043add61f5e5736562e5df0dade3859c40f3394e44865"),
  hexagon: company("hexagon", "https://images.unsplash.com/photo-1581091212991-8891c7d4bd9b?auto=format&fit=crop&w=1600&q=80", "Unsplash", "https://unsplash.com/photos/engineers-working-in-automotive-factory-WjOWazUPAss", "ThisisEngineering (@thisisengineering)", "2e14dcf32949680c162449f5e64978e4d9ff51c98d8fa89b3b7a7655678fb2bc"),
  euroNova: company("euro-nova", "https://images.unsplash.com/photo-1715059120691-d6b06c275d74?auto=format&fit=crop&w=1600&q=80", "Unsplash", "https://unsplash.com/photos/a-close-up-of-a-machine-that-is-making-something-vAaMI6vb42M", "Jakub Żerdzicki (@jakubzerdzicki)", "d5916510b6b530b484432405df77492b7049f250c95190aa3edd03dae7e649ad"),
  azteca: company("azteca", "https://images.unsplash.com/photo-1775519520461-6b6e068d9250?auto=format&fit=crop&w=1600&q=80", "Unsplash", "https://unsplash.com/photos/two-server-racks-filled-with-electronic-components-and-wires-k27hkqXuveo", "Eric Stoynov (@ericstoynov)", "57398b132a19c2e0232d1bf1efd8737493d0e6f8febcad228ee2135350af1c2a"),
  sakura: company("sakura", "https://images.unsplash.com/photo-1764114235891-66ff86abaf87?auto=format&fit=crop&w=1600&q=80", "Unsplash", "https://unsplash.com/photos/industrial-laser-cutter-working-on-metal-sheet-x0Q7F6h-dXk", "Zoshua Colah", "ce503a15866c99464b675bb6da5c5b1ccd312fdde1aeb5a7c994b76d13eb2dea"),
  britannia: company("britannia", "https://images.unsplash.com/photo-1773517458853-1afbaee86901?auto=format&fit=crop&w=1600&q=80", "Unsplash", "https://unsplash.com/photos/industrial-machinery-with-pipes-and-valves-sIfOwIa8Lq0", "Dave Meckler (@phosphorvs)", "9101d5c611621834afe3b68044af06bd1e3ff90a9b32d9b53496701088b07801"),
  iberia: company("iberia", "https://images.unsplash.com/photo-1779582870861-15e83c247f5b?auto=format&fit=crop&w=1600&q=80", "Unsplash", "https://unsplash.com/photos/wind-farm-on-golden-hills-beneath-a-vibrant-blue-sky-OtQmRQkPgI0", "Fabio Sasso (@abduzeedo)", "2c72147fc9088a2cdc0b9fdf95230ff24bf44d3e7a59087bebc43b6e892a0fd3"),
  southernCross: company("southern-cross", "https://images.unsplash.com/photo-1781546441914-346427be684c?auto=format&fit=crop&w=1600&q=80", "Unsplash", "https://unsplash.com/photos/conveyor-belts-silos-and-wind-turbines-in-an-industrial-landscape-rxKeI15-XRw", "Sorin Basangeac (@sorinbasangeac)", "115a7cedf5eef7db9e83e6aa567ea7186f69a0e281fb98a26bf571639732c1ce")
});

export const DEMO_MEDIA_ASSETS = Object.freeze([
  ...Object.values(DEMO_PERSON_MEDIA),
  ...Object.values(DEMO_COMPANY_MEDIA)
]);
