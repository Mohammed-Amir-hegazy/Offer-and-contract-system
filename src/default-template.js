// Starter contract template. The admin replaces it from the settings page
// (by editing it directly or by uploading the company's Word contract).
const DEFAULT_CONTRACT_TEMPLATE = `
<h1 style="text-align:center">عقد بيع وحدة سكنية</h1>
<p style="text-align:center">رقم العقد: {{contract_number}} — تحريراً في يوم {{contract_day}} الموافق {{contract_date}}</p>

<h3>أطراف العقد</h3>
<p><strong>أولاً: {{company_name}}</strong>، وعنوانها {{company_address}}، ويمثلها في التوقيع على هذا العقد السيد/ {{owner_name}}. <em>(طرف أول – بائع)</em></p>
<p><strong>ثانياً: السيد/ {{client_name}}</strong>، {{client_nationality}} الجنسية، ويحمل رقم قومي {{client_national_id}}، والمقيم في {{client_address}}، هاتف {{client_phone}}. <em>(طرف ثانٍ – مشترٍ)</em></p>

<h3>تمهيد</h3>
<p>يمتلك الطرف الأول مشروع {{project_name}}، وقد رغب الطرف الثاني في شراء الوحدة الموضحة بالبند الأول، وبعد أن أقر الطرفان بأهليتهما للتعاقد اتفقا على ما يلي:</p>

<h3>البند الأول: وصف الوحدة</h3>
<p>باع الطرف الأول للطرف الثاني القابل لذلك الوحدة رقم <strong>{{unit_code}}</strong> بالعمارة {{building}} مدخل {{entrance}} – {{floor}}، نموذج رقم {{model_no}}، بمساحة إجمالية {{area}} م² تقريباً، وعدد غرف {{rooms}}، ومساحة حديقة {{garden_area}} م² (إن وجدت)، بالإضافة إلى وحدة جراج ملحقة بالوحدة.</p>

<h3>البند الثاني: الثمن</h3>
<p>تم هذا البيع نظير ثمن إجمالي قدره <strong>{{net_price}} ج.م</strong> ({{net_price_words}}) للوحدة بعد خصم {{discount_pct}}%، بالإضافة إلى ثمن الجراج وقدره {{garage_price}} ج.م ({{garage_price_words}})، ليكون إجمالي قيمة العقد <strong>{{total_contract}} ج.م</strong> ({{total_contract_words}}).</p>

<h3>البند الثالث: طريقة السداد</h3>
<p>يسدد الطرف الثاني مبلغ {{down_payment}} ج.م ({{down_payment_words}}) كمقدم تعاقد بنسبة {{down_payment_pct}}% عند التوقيع، ويسدد الباقي على عدد {{installments_count}} قسط {{installment_frequency}} لمدة {{years}} سنوات، يستحق أولها في {{first_installment_date}} وآخرها في {{last_installment_date}} وفقاً للجدول التالي:</p>
{{installments_table}}

<h3>البند الرابع: وديعة الصيانة</h3>
<p>يلتزم الطرف الثاني بسداد وديعة صيانة بنسبة {{maintenance_pct}}% من ثمن الوحدة بقيمة {{maintenance_amount}} ج.م ({{maintenance_amount_words}})، تُوزع على الأقساط بدءاً من القسط رقم {{maintenance_start_installment}} كما هو موضح بجدول السداد.</p>

<h3>البند الخامس: الاستلام</h3>
<p>يلتزم الطرف الأول بتسليم الوحدة للطرف الثاني في الموعد المتفق عليه بعد سداد المستحقات المتفق عليها.</p>

<h3>البند السادس: النسخ</h3>
<p>حُرر هذا العقد من نسختين بيد كل طرف نسخة للعمل بموجبها عند اللزوم.</p>

<table class="signatures">
  <tr>
    <td><strong>الطرف الأول (البائع)</strong><br>{{company_name}}<br>{{company_signature}}<br>الاسم: {{company_signer_name}}</td>
    <td><strong>الطرف الثاني (المشتري)</strong><br>{{client_name}}<br>{{client_signature}}<br>الاسم: {{client_name}}</td>
  </tr>
</table>
`.trim();

module.exports = { DEFAULT_CONTRACT_TEMPLATE };
